import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

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

function toInt(v: any): number | null {
  const n = toNum(v);
  return n !== null ? Math.round(n) : null;
}

async function sendResultsEmail(sb: any, clientId: string, scanType: string, parsed: any) {
  if (!RESEND_API_KEY) return;

  const { data: { user }, error: userErr } = await sb.auth.admin.getUserById(clientId);
  if (userErr || !user?.email) return;

  const { data: profile } = await sb.from('profiles').select('full_name').eq('id', clientId).single();
  const firstName = profile?.full_name?.split(' ')[0] || 'there';

  let subject = '';
  let bodyLines: string[] = [];

  if (scanType === 'DEXA') {
    subject = 'Your DEXA Scan Results — XGYM Castle Hill';

    // Pull previous scan to show change if available
    const { data: prev } = await sb
      .from('dexa_scans')
      .select('fat_pct, lean_g, vat_area_cm2')
      .eq('client_id', clientId)
      .lt('scan_date', parsed.scan_date)
      .order('scan_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Body fat line
    if (parsed.fat_pct != null) {
      const fat = Number(parsed.fat_pct).toFixed(1);
      let fatNote = '';
      if (prev?.fat_pct != null) {
        const diff = Number(parsed.fat_pct) - Number(prev.fat_pct);
        if (Math.abs(diff) >= 0.1) fatNote = diff < 0 ? ` (down ${Math.abs(diff).toFixed(1)}% from last time)` : ` (up ${diff.toFixed(1)}% from last time)`;
      }
      bodyLines.push(`• Body fat: <strong>${fat}%</strong>${fatNote}`);
    }

    // Lean mass line
    if (parsed.lean_g != null) {
      const leanKg = (parsed.lean_g / 1000).toFixed(1);
      let leanNote = '';
      if (prev?.lean_g != null) {
        const diffG = parsed.lean_g - prev.lean_g;
        if (Math.abs(diffG) >= 100) leanNote = diffG > 0 ? ` (up ${(diffG/1000).toFixed(1)} kg)` : ` (down ${(Math.abs(diffG)/1000).toFixed(1)} kg)`;
      }
      bodyLines.push(`• Lean mass: <strong>${leanKg} kg</strong>${leanNote}`);
    }

    // VAT line with plain-English status
    if (parsed.vat_area_cm2 != null) {
      const vat = Number(parsed.vat_area_cm2);
      const vatStatus = vat < 100 ? 'in the healthy range' : vat <= 160 ? 'borderline — worth keeping an eye on' : 'elevated — something to work on';
      bodyLines.push(`• VAT area: <strong>${vat} cm²</strong> — ${vatStatus}`);
    }

  } else if (scanType === 'RMR') {
    subject = 'Your RMR Results — XGYM Castle Hill';

    if (parsed.kcal != null) {
      bodyLines.push(`• Resting metabolic rate: <strong>${parsed.kcal} kcal/day</strong>`);
    }
    if (parsed.fat_pct != null) {
      const fatBurn = Number(parsed.fat_pct).toFixed(0);
      const fatNote = Number(parsed.fat_pct) >= 80 ? ' — excellent fat burning' : Number(parsed.fat_pct) >= 65 ? ' — good, aim for 80%+' : ' — room to improve';
      bodyLines.push(`• Fat burning: <strong>${fatBurn}%</strong>${fatNote}`);
    }
    if (parsed.glucose_pct != null) {
      bodyLines.push(`• Glucose reliance: <strong>${Number(parsed.glucose_pct).toFixed(0)}%</strong>`);
    }

  } else if (scanType === 'BLOOD') {
    subject = 'Your Blood Panel Results — XGYM Castle Hill';
    const markers = parsed.markers || [];
    const outOfRange = markers.filter((m: any) => m.status === 'high' || m.status === 'low');
    if (outOfRange.length === 0) {
      bodyLines.push(`All ${markers.length} markers came back within range — good result.`);
    } else {
      const names = outOfRange.slice(0, 3).map((m: any) => m.name).join(', ');
      bodyLines.push(`${markers.length} markers tested — ${outOfRange.length} flagged (${names}${outOfRange.length > 3 ? ' and more' : ''}). Full detail is in the app.`);
    }

  } else if (scanType === 'HORMONES') {
    subject = 'Your Hormone Panel Results — XGYM Castle Hill';
    const markers = parsed.markers || [];
    const outOfRange = markers.filter((m: any) => m.status === 'high' || m.status === 'low');
    if (outOfRange.length === 0) {
      bodyLines.push(`All ${markers.length} markers came back within range.`);
    } else {
      const names = outOfRange.slice(0, 3).map((m: any) => m.name).join(', ');
      bodyLines.push(`${markers.length} markers tested — ${outOfRange.length} flagged (${names}${outOfRange.length > 3 ? ' and more' : ''}). Full detail is in the app.`);
    }
  }

  if (!subject) return;

  const resultsList = bodyLines.map(l => `<p style="margin:4px 0;font-size:15px;color:#222">${l}</p>`).join('\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4">
    <tr><td align="center" style="padding:32px 16px">
      <table cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:4px;border:1px solid #e0e0e0">
        <tr>
          <td style="padding:28px 32px 0">
            <p style="margin:0 0 20px;font-size:15px;color:#222;line-height:1.7">Hi ${firstName},</p>
            <p style="margin:0 0 16px;font-size:15px;color:#222;line-height:1.7">Your DEXA report has been uploaded to your Life X profile. You can also download the <a href="https://lifex.xgym.com.au/dexa-interpretation-guide.pdf" style="color:#b8860b;font-weight:600">DEXA Interpretation Guide</a> for help understanding your results.</p>
            <p style="margin:0 0 12px;font-size:15px;color:#222;line-height:1.7">Here's a quick look at your key numbers:</p>
            <div style="background:#f9f9f9;border-left:3px solid #C9A84C;padding:14px 18px;margin-bottom:20px;border-radius:0 4px 4px 0">
              ${resultsList}
            </div>
            <p style="margin:0 0 16px;font-size:15px;color:#222;line-height:1.7">
              You can view your full results — including bone density, regional breakdown, and comparisons with previous scans — in the Life X app:<br>
              <a href="https://lifex.xgym.com.au/dashboard.html" style="color:#b8860b;font-weight:600">lifex.xgym.com.au</a>
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#222;line-height:1.7">
              If you were happy with your appointment today, feel free to leave a Google review — it only takes a minute:<br>
              <a href="https://g.page/r/CaGLAWIoh-6oEBM/review" style="color:#b8860b">https://g.page/r/CaGLAWIoh-6oEBM/review</a>
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#222;line-height:1.7">If you have any questions, just reply to this email.</p>
            <p style="margin:0 0 4px;font-size:15px;color:#222">Thanks!</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px;border-top:1px solid #ebebeb;margin-top:16px">
            <p style="margin:0 0 2px;font-size:13px;color:#555;font-weight:600">The Life X Team</p>
            <p style="margin:0 0 2px;font-size:13px;color:#555">DEXA Scan Technician — XGYM Castle Hill</p>
            <p style="margin:0 0 2px;font-size:13px;color:#555">website <a href="https://xgym.com.au/dexa-scan" style="color:#b8860b;text-decoration:none">xgym.com.au/dexa-scan</a></p>
            <p style="margin:0 0 2px;font-size:13px;color:#555">phone: 0424 023 601</p>
            <p style="margin:0;font-size:13px;color:#555">location: 5/9 Salisbury Rd, Castle Hill NSW 2154</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'DEXA XGYM Castle Hill <dexa@xgym.com.au>',
        to: [user.email],
        reply_to: 'dexa@xgym.com.au',
        subject,
        html,
      }),
    });
  } catch {
    // non-fatal
  }
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
{"type":"DEXA","scan_date":"YYYY-MM-DD","scan_number":1,"dob":"YYYY-MM-DD","patient_age":0,"sex":"male","height_cm":0.0,"weight_kg":0.0,"fat_pct":0.0,"fat_g":0,"lean_g":0,"total_g":0,"bmd":0.0,"t_score":0.0,"z_score":0.0,"pr_pct":0.0,"vat_g":0,"vat_area_cm2":0.0,"android_fat_pct":0.0,"gynoid_fat_pct":0.0,"ag_ratio":0.0,"trunk_fat_pct":0.0,"ffmi":0.0,"almi":0.0,"fmi":0.0,"left_arm_fat_pct":0.0,"right_arm_fat_pct":0.0,"left_leg_fat_pct":0.0,"right_leg_fat_pct":0.0,"left_arm_lean_g":0,"right_arm_lean_g":0,"left_leg_lean_g":0,"right_leg_lean_g":0,"left_arm_fat_g":0,"right_arm_fat_g":0,"left_leg_fat_g":0,"right_leg_fat_g":0}

Extract from the patient info header: patient_age (integer years), sex ("male" or "female"), height_cm (numeric), weight_kg (numeric), dob (date of birth as YYYY-MM-DD).
Extract from Adipose Indices: fmi = "Fat Mass/Height²", vat_area_cm2 = "Est. VAT Area (cm²)".
Extract from Lean Indices: ffmi = "Lean/Height²", almi = "Appen. Lean/Height²".
Extract trunk_fat_pct from the Trunk row % Fat in the Body Composition Results table.
Extract segmental data from the Body Composition Results table: for the "L Arm" row extract % Fat → left_arm_fat_pct, Lean (g) → left_arm_lean_g, Fat (g) → left_arm_fat_g; for "R Arm" → right_arm_fat_pct, right_arm_lean_g, right_arm_fat_g; for "L Leg" → left_leg_fat_pct, left_leg_lean_g, left_leg_fat_g; for "R Leg" → right_leg_fat_pct, right_leg_lean_g, right_leg_fat_g.

For RMR:
{"type":"RMR","test_date":"YYYY-MM-DD","kcal":0,"kj":0,"fat_pct":0.0,"glucose_pct":0.0,"feo2":0.0,"pop_min":0,"pop_max":0}

For BLOOD:
{"type":"BLOOD","panel_date":"YYYY-MM-DD","lab_name":"","markers":[{"category":"","name":"","value":0.0,"unit":"","ref_min":0.0,"ref_max":0.0,"display_min":0.0,"display_max":0.0,"status":"normal"}]}

For HORMONES:
{"type":"HORMONES","panel_date":"YYYY-MM-DD","markers":[{"name":"","value":0.0,"unit":"","ref_min":0.0,"ref_max":0.0,"display_min":0.0,"display_max":0.0,"status":"normal","note":""}]}

Status must be one of: normal, high, low, optimal.

If the document is NOT a health scan (e.g. a referral letter, consent form, invoice, or bone density-only report without body composition data), return exactly: {"type":"UNKNOWN"}

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
        scan_number: toInt(parsed.scan_number),
        dob: parsed.dob || null,
        patient_age: toInt(parsed.patient_age),
        sex: parsed.sex || null,
        height_cm: toNum(parsed.height_cm),
        weight_kg: toNum(parsed.weight_kg),
        fat_pct: toNum(parsed.fat_pct),
        fat_g: toInt(parsed.fat_g),
        lean_g: toInt(parsed.lean_g),
        total_g: toInt(parsed.total_g),
        bmd: parsed.bmd,
        t_score: parsed.t_score,
        z_score: parsed.z_score,
        pr_pct: parsed.pr_pct,
        vat_g: toInt(parsed.vat_g),
        vat_area_cm2: toNum(parsed.vat_area_cm2),
        android_fat_pct: parsed.android_fat_pct,
        gynoid_fat_pct: parsed.gynoid_fat_pct,
        ag_ratio: parsed.ag_ratio,
        trunk_fat_pct: toNum(parsed.trunk_fat_pct),
        ffmi: toNum(parsed.ffmi),
        almi: toNum(parsed.almi),
        fmi: toNum(parsed.fmi),
        left_arm_fat_pct: toNum(parsed.left_arm_fat_pct),
        right_arm_fat_pct: toNum(parsed.right_arm_fat_pct),
        left_leg_fat_pct: toNum(parsed.left_leg_fat_pct),
        right_leg_fat_pct: toNum(parsed.right_leg_fat_pct),
        left_arm_lean_g: toInt(parsed.left_arm_lean_g),
        right_arm_lean_g: toInt(parsed.right_arm_lean_g),
        left_leg_lean_g: toInt(parsed.left_leg_lean_g),
        right_leg_lean_g: toInt(parsed.right_leg_lean_g),
        left_arm_fat_g: toInt(parsed.left_arm_fat_g),
        right_arm_fat_g: toInt(parsed.right_arm_fat_g),
        left_leg_fat_g: toInt(parsed.left_leg_fat_g),
        right_leg_fat_g: toInt(parsed.right_leg_fat_g),
        pdf_path: pdfPath,
      }, { onConflict: 'client_id,scan_date' });
      if (error) return cors(JSON.stringify({ error: error.message }), 500);
      sendResultsEmail(sb, clientId, 'DEXA', parsed);

    } else if (scanType === 'RMR') {
      const { error } = await sb.from('rmr_tests').insert({
        client_id: clientId,
        test_date: parsed.test_date,
        kcal: toInt(parsed.kcal),
        kj: toInt(parsed.kj),
        fat_pct: parsed.fat_pct,
        glucose_pct: parsed.glucose_pct,
        feo2: parsed.feo2,
        pop_min: toInt(parsed.pop_min),
        pop_max: toInt(parsed.pop_max),
        pdf_path: pdfPath,
      });
      if (error) return cors(JSON.stringify({ error: error.message }), 500);
      sendResultsEmail(sb, clientId, 'RMR', parsed);

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
      sendResultsEmail(sb, clientId, 'BLOOD', parsed);

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
      sendResultsEmail(sb, clientId, 'HORMONES', parsed);
    }

    if (scanType === 'UNKNOWN') {
      return cors(JSON.stringify({ success: true, type: 'UNKNOWN', skipped: true }));
    }

    return cors(JSON.stringify({ success: true, type: scanType }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
