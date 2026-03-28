import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
    },
  });
}

// Strip comparison operators and convert to number (handles "<0.1", ">200", etc.)
function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[<>≤≥\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });

  try {
    const { pdfBase64, clientId } = await req.json();

    if (!pdfBase64 || !clientId) {
      return cors(JSON.stringify({ error: 'Missing pdfBase64 or clientId' }), 400);
    }

    // Send PDF to Claude for parsing
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64,
              },
            },
            {
              type: 'text',
              text: `Analyse this health scan PDF and extract the data.

First, identify the scan type: DEXA, BLOOD, HORMONES, or RMR.

Then extract all relevant data and return ONLY a valid JSON object with this structure:

For DEXA:
{"type":"DEXA","scan_date":"YYYY-MM-DD","scan_number":1,"dob":"YYYY-MM-DD","patient_age":0,"sex":"male","height_cm":0.0,"weight_kg":0.0,"fat_pct":0.0,"fat_g":0,"lean_g":0,"total_g":0,"bmd":0.0,"t_score":0.0,"z_score":0.0,"pr_pct":0.0,"vat_g":0,"vat_area_cm2":0.0,"android_fat_pct":0.0,"gynoid_fat_pct":0.0,"ag_ratio":0.0,"trunk_fat_pct":0.0,"ffmi":0.0,"almi":0.0,"fmi":0.0}

Extract from the patient info header: patient_age (integer years), sex ("male" or "female"), height_cm (numeric), weight_kg (numeric), dob (date of birth as YYYY-MM-DD).
Extract from Adipose Indices: fmi = "Fat Mass/Height²", vat_area_cm2 = "Est. VAT Area (cm²)".
Extract from Lean Indices: ffmi = "Lean/Height²", almi = "Appen. Lean/Height²".
Extract trunk_fat_pct from the Trunk row % Fat in the Body Composition Results table.

For RMR:
{"type":"RMR","test_date":"YYYY-MM-DD","kcal":0,"kj":0,"fat_pct":0.0,"glucose_pct":0.0,"feo2":0.0,"pop_min":0,"pop_max":0}

For BLOOD:
{"type":"BLOOD","panel_date":"YYYY-MM-DD","lab_name":"","markers":[{"category":"","name":"","value":0.0,"unit":"","ref_min":0.0,"ref_max":0.0,"display_min":0.0,"display_max":0.0,"status":"normal"}]}

For HORMONES:
{"type":"HORMONES","panel_date":"YYYY-MM-DD","markers":[{"name":"","value":0.0,"unit":"","ref_min":0.0,"ref_max":0.0,"display_min":0.0,"display_max":0.0,"status":"normal","note":""}]}

Status must be one of: normal, high, low, optimal.
Return ONLY the JSON, no other text.`,
            },
          ],
        }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (claudeData.type === 'error') {
      return cors(JSON.stringify({ error: `Claude API error: ${claudeData.error?.message || JSON.stringify(claudeData.error)}` }), 500);
    }
    const rawText = claudeData.content?.[0]?.text || '';

    let parsed: any;
    try {
      // Strip markdown code fences if present
      const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
      parsed = JSON.parse(clean);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) return cors(JSON.stringify({ error: 'Could not parse Claude response', raw: rawText.slice(0, 500) }), 500);
      try {
        parsed = JSON.parse(match[0]);
      } catch (e2) {
        return cors(JSON.stringify({ error: `JSON parse failed: ${String(e2)}`, raw: rawText.slice(0, 500) }), 500);
      }
    }

    // Save to Supabase using service role (bypasses RLS)
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const scanType = parsed.type;

    // Upload original PDF to storage
    const scanDate = parsed.scan_date || parsed.panel_date || parsed.test_date || new Date().toISOString().slice(0, 10);
    const pdfPath = `${clientId}/${scanDate}-${scanType.toLowerCase()}.pdf`;
    const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    await sb.storage.from('scans').upload(pdfPath, pdfBytes, {
      contentType: 'application/pdf',
      upsert: true,
    });
    // (storage errors are non-fatal — data still saves)

    if (scanType === 'DEXA') {
      const { error } = await sb.from('dexa_scans').upsert({
        client_id: clientId,
        scan_date: parsed.scan_date,
        scan_number: parsed.scan_number,
        dob: parsed.dob || null,
        patient_age: parsed.patient_age || null,
        sex: parsed.sex || null,
        height_cm: toNum(parsed.height_cm),
        weight_kg: toNum(parsed.weight_kg),
        fat_pct: parsed.fat_pct,
        fat_g: parsed.fat_g,
        lean_g: parsed.lean_g,
        total_g: parsed.total_g,
        bmd: parsed.bmd,
        t_score: parsed.t_score,
        z_score: parsed.z_score,
        pr_pct: parsed.pr_pct,
        vat_g: parsed.vat_g,
        vat_area_cm2: toNum(parsed.vat_area_cm2),
        android_fat_pct: parsed.android_fat_pct,
        gynoid_fat_pct: parsed.gynoid_fat_pct,
        ag_ratio: parsed.ag_ratio,
        trunk_fat_pct: toNum(parsed.trunk_fat_pct),
        ffmi: toNum(parsed.ffmi),
        almi: toNum(parsed.almi),
        fmi: toNum(parsed.fmi),
        pdf_path: pdfPath,
      }, { onConflict: 'client_id,scan_date' });
      if (error) return cors(JSON.stringify({ error: error.message }), 500);

    } else if (scanType === 'RMR') {
      const { error } = await sb.from('rmr_tests').insert({
        client_id: clientId,
        test_date: parsed.test_date,
        kcal: parsed.kcal,
        kj: parsed.kj,
        fat_pct: parsed.fat_pct,
        glucose_pct: parsed.glucose_pct,
        feo2: parsed.feo2,
        pop_min: parsed.pop_min,
        pop_max: parsed.pop_max,
        pdf_path: pdfPath,
      });
      if (error) return cors(JSON.stringify({ error: error.message }), 500);

    } else if (scanType === 'BLOOD') {
      const { data: panel, error: panelErr } = await sb.from('blood_panels').insert({
        client_id: clientId,
        panel_date: parsed.panel_date,
        lab_name: parsed.lab_name || '',
        pdf_path: pdfPath,
      }).select().single();
      if (panelErr) return cors(JSON.stringify({ error: panelErr.message }), 500);

      const markers = parsed.markers.map((m: any) => ({
        panel_id: panel.id,
        category: m.category || 'Other',
        name: m.name,
        value: toNum(m.value) ?? 0,
        unit: m.unit || '',
        display_min: toNum(m.display_min) ?? 0,
        display_max: toNum(m.display_max) ?? 100,
        ref_min: toNum(m.ref_min) ?? 0,
        ref_max: toNum(m.ref_max) ?? 0,
        status: m.status || 'normal',
      }));
      const { error: markersErr } = await sb.from('blood_markers').insert(markers);
      if (markersErr) return cors(JSON.stringify({ error: markersErr.message }), 500);

    } else if (scanType === 'HORMONES') {
      const { data: panel, error: panelErr } = await sb.from('hormone_panels').insert({
        client_id: clientId,
        panel_date: parsed.panel_date,
        pdf_path: pdfPath,
      }).select().single();
      if (panelErr) return cors(JSON.stringify({ error: panelErr.message }), 500);

      const markers = parsed.markers.map((m: any) => ({
        panel_id: panel.id,
        name: m.name,
        value: toNum(m.value) ?? 0,
        unit: m.unit || '',
        display_min: toNum(m.display_min) ?? 0,
        display_max: toNum(m.display_max) ?? 100,
        ref_min: toNum(m.ref_min) ?? 0,
        ref_max: toNum(m.ref_max) ?? 0,
        status: m.status || 'normal',
        note: m.note || '',
      }));
      const { error: markersErr } = await sb.from('hormone_markers').insert(markers);
      if (markersErr) return cors(JSON.stringify({ error: markersErr.message }), 500);
    }

    return cors(JSON.stringify({ success: true, type: scanType }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
