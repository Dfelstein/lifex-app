import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY  = Deno.env.get('RESEND_API_KEY')!;
const R2_ACCESS_KEY   = Deno.env.get('R2_ACCESS_KEY_ID')!;
const R2_SECRET_KEY   = Deno.env.get('R2_SECRET_ACCESS_KEY')!;
const R2_ACCOUNT_ID   = '20a98cdbaaa18ad93be74da2a7a145aa';
const R2_BUCKET       = 'lifex-app';
const R2_ENDPOINT     = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const ALLOWED_ORIGINS = [
  'https://lifexclinic.com.au',
  'https://www.lifexclinic.com.au',
  'https://lifex.xgym.com.au',
];

function cors(body: string, status = 200, origin = '') {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  // A 204 response must have a null body, or Deno throws and the preflight 500s
  return new Response(status === 204 ? null : body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

const aws = new AwsClient({
  accessKeyId: R2_ACCESS_KEY,
  secretAccessKey: R2_SECRET_KEY,
  service: 's3',
  region: 'auto',
});

async function r2SignedUrl(key: string, expirySeconds = 604800): Promise<string | null> {
  try {
    const url = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    // Signing never fails on its own, so check the object exists before using R2
    const head = await aws.fetch(url.toString(), { method: 'HEAD' });
    if (!head.ok) return null;
    url.searchParams.set('X-Amz-Expires', String(expirySeconds));
    const signed = await aws.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
    return signed.url;
  } catch {
    return null;
  }
}

// Fetch a scan PDF's bytes: R2 first, then Supabase Storage
async function downloadPdf(adminClient: ReturnType<typeof createClient>, key: string): Promise<Uint8Array | null> {
  try {
    const res = await aws.fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch { /* fall through to Supabase Storage */ }
  const { data } = await adminClient.storage.from('scans').download(key);
  return data ? new Uint8Array(await data.arrayBuffer()) : null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  if (req.method === 'OPTIONS') return cors('', 204, origin);
  if (req.method !== 'POST') return cors(JSON.stringify({ error: 'Method not allowed' }), 405, origin);

  const safeResponse = JSON.stringify({
    message: "If we have your records on file, you'll receive an email with your scan results within a few minutes.",
  });

  try {
    const { name, email } = await req.json();
    if (!email || !name) return cors(JSON.stringify({ error: 'Name and email are required' }), 400, origin);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // listUsers is paginated, so walk every page to find the client
    let user = null;
    for (let page = 1; !user; page++) {
      const { data: { users }, error: userErr } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
      if (userErr) throw userErr;
      user = users.find(u => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
      if (users.length < 1000) break;
    }
    if (!user) return cors(safeResponse, 200, origin);

    const { data: scans, error: scanErr } = await adminClient
      .from('dexa_scans')
      .select('id, scan_date, pdf_path, scan_number')
      .eq('client_id', user.id)
      .not('pdf_path', 'is', null)
      .neq('pdf_path', '')
      .order('scan_date', { ascending: false });

    if (scanErr || !scans || scans.length === 0) return cors(safeResponse, 200, origin);

    const fmtDate = (d: string) =>
      new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

    // Latest scan goes in as a PDF attachment; older scans are sent as links
    const [latest, ...older] = scans;
    const latestBytes = await downloadPdf(adminClient, latest.pdf_path as string);
    const linkScans = latestBytes ? older : scans;

    const scanLinks: { date: string; number: number; url: string }[] = [];
    for (const scan of linkScans) {
      const path = scan.pdf_path as string;

      // Try R2 first, fall back to Supabase Storage
      let signedUrl = await r2SignedUrl(path);
      if (!signedUrl) {
        const { data } = await adminClient.storage.from('scans').createSignedUrl(path, 604800);
        signedUrl = data?.signedUrl ?? null;
      }

      if (signedUrl) {
        scanLinks.push({ date: scan.scan_date, number: scan.scan_number, url: signedUrl });
      }
    }

    if (!latestBytes && scanLinks.length === 0) return cors(safeResponse, 200, origin);

    const scanRows = scanLinks.map(s =>
      `<tr style="border-bottom:1px solid #e7e0d1;">
        <td style="padding:12px 16px;font-family:Georgia,serif;font-size:15px;">Scan #${s.number}</td>
        <td style="padding:12px 16px;color:#948d7f;font-size:14px;">${fmtDate(s.date)}</td>
        <td style="padding:12px 16px;"><a href="${s.url}" style="background:#b98f3b;color:#1b1917;padding:8px 18px;border-radius:6px;font-size:13px;font-weight:700;text-decoration:none;">Download PDF</a></td>
      </tr>`
    ).join('');

    const attachedNote = latestBytes
      ? `<p>Your latest scan (<strong>Scan #${latest.scan_number}, ${fmtDate(latest.scan_date)}</strong>) is attached to this email as a PDF.</p>`
      : '';
    const linksSection = scanLinks.length
      ? `<p>${latestBytes ? 'Your earlier scans are below.' : 'Here are your LifeX scan results.'} Each download link is valid for <strong>7 days</strong>. If you need them re-sent after that, visit <a href="https://lifexclinic.com.au/resend" style="color:#b98f3b;">lifexclinic.com.au/resend</a> anytime.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <tr style="background:#f1ece1;">
        <th style="text-align:left;padding:10px 16px;font-size:12px;color:#948d7f;font-weight:600;">Scan</th>
        <th style="text-align:left;padding:10px 16px;font-size:12px;color:#948d7f;font-weight:600;">Date</th>
        <th style="text-align:left;padding:10px 16px;font-size:12px;color:#948d7f;font-weight:600;"> </th>
      </tr>
      ${scanRows}
    </table>`
      : '';

    // name comes from the public form, so escape it before putting it in the email
    const firstName = (name as string).split(' ')[0]
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const html = `
<html><body style="font-family:Arial,sans-serif;font-size:15px;color:#1b1917;line-height:1.6;max-width:600px;margin:0 auto;padding:24px;background:#f1ece1;">
  <div style="background:#1b1917;padding:24px 28px;border-radius:10px 10px 0 0;">
    <p style="font-size:20px;font-weight:700;color:#f1ece1;margin:0;letter-spacing:0.04em;">LifeX <span style="color:#b98f3b;">Clinic</span></p>
    <p style="font-size:12px;color:#948d7f;margin:4px 0 0;letter-spacing:0.08em;text-transform:uppercase;">Your scan results</p>
  </div>
  <div style="background:#fff;padding:28px;border-radius:0 0 10px 10px;">
    <p>Hi ${firstName},</p>
    ${attachedNote}
    ${linksSection}
    <hr style="border:none;border-top:1px solid #e7e0d1;margin:24px 0;">
    <p style="font-size:14px;color:#948d7f;">Due for a rescan? DEXA every 3–6 months shows exactly what's changed.</p>
    <a href="https://xgym.com.au/dexa-scan/?utm_source=resend-email&utm_medium=email&utm_campaign=rescan#book-now" style="display:inline-block;background:#b98f3b;color:#1b1917;padding:12px 26px;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none;margin-top:8px;">Book a rescan</a>
    <p style="font-size:13px;color:#948d7f;margin-top:24px;">LifeX Clinic · 5/9 Salisbury Rd, Castle Hill NSW 2154<br>0424 023 601 · <a href="mailto:info@lifexclinic.com.au" style="color:#b98f3b;">info@lifexclinic.com.au</a></p>
  </div>
</body></html>`;

    const total = scanLinks.length + (latestBytes ? 1 : 0);
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'LifeX Clinic <dexa@xgym.com.au>',
        to: [email],
        subject: `Your LifeX scan results (${total} scan${total > 1 ? 's' : ''})`,
        html,
        ...(latestBytes && {
          attachments: [{
            filename: `LifeX-Scan-${latest.scan_number}-${(latest.scan_date as string).slice(0, 10)}.pdf`,
            content: encodeBase64(latestBytes),
          }],
        }),
      }),
    });
    if (!sendRes.ok) console.error('Resend error:', sendRes.status, await sendRes.text());

    return cors(safeResponse, 200, origin);
  } catch (e) {
    console.error('resend-scan error:', e);
    return cors(safeResponse, 200, origin);
  }
});
