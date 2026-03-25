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
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2000,
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
{"type":"DEXA","scan_date":"YYYY-MM-DD","scan_number":1,"fat_pct":0.0,"fat_g":0,"lean_g":0,"total_g":0,"bmd":0.0,"t_score":0.0,"z_score":0.0,"pr_pct":0.0,"vat_g":0,"android_fat_pct":0.0,"gynoid_fat_pct":0.0,"ag_ratio":0.0}

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
    const rawText = claudeData.content?.[0]?.text || '';

    let parsed: any;
    try {
      parsed = JSON.parse(rawText.trim());
    } catch {
      // Try to extract JSON from the response
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) return cors(JSON.stringify({ error: 'Could not parse Claude response', raw: rawText }), 500);
      parsed = JSON.parse(match[0]);
    }

    // Save to Supabase using service role (bypasses RLS)
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const scanType = parsed.type;

    if (scanType === 'DEXA') {
      const { error } = await sb.from('dexa_scans').insert({
        client_id: clientId,
        scan_date: parsed.scan_date,
        scan_number: parsed.scan_number,
        fat_pct: parsed.fat_pct,
        fat_g: parsed.fat_g,
        lean_g: parsed.lean_g,
        total_g: parsed.total_g,
        bmd: parsed.bmd,
        t_score: parsed.t_score,
        z_score: parsed.z_score,
        pr_pct: parsed.pr_pct,
        vat_g: parsed.vat_g,
        android_fat_pct: parsed.android_fat_pct,
        gynoid_fat_pct: parsed.gynoid_fat_pct,
        ag_ratio: parsed.ag_ratio,
      });
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
      });
      if (error) return cors(JSON.stringify({ error: error.message }), 500);

    } else if (scanType === 'BLOOD') {
      const { data: panel, error: panelErr } = await sb.from('blood_panels').insert({
        client_id: clientId,
        panel_date: parsed.panel_date,
        lab_name: parsed.lab_name || '',
      }).select().single();
      if (panelErr) return cors(JSON.stringify({ error: panelErr.message }), 500);

      const markers = parsed.markers.map((m: any) => ({ ...m, panel_id: panel.id }));
      const { error: markersErr } = await sb.from('blood_markers').insert(markers);
      if (markersErr) return cors(JSON.stringify({ error: markersErr.message }), 500);

    } else if (scanType === 'HORMONES') {
      const { data: panel, error: panelErr } = await sb.from('hormone_panels').insert({
        client_id: clientId,
        panel_date: parsed.panel_date,
      }).select().single();
      if (panelErr) return cors(JSON.stringify({ error: panelErr.message }), 500);

      const markers = parsed.markers.map((m: any) => ({ ...m, panel_id: panel.id }));
      const { error: markersErr } = await sb.from('hormone_markers').insert(markers);
      if (markersErr) return cors(JSON.stringify({ error: markersErr.message }), 500);
    }

    return cors(JSON.stringify({ success: true, type: scanType }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
