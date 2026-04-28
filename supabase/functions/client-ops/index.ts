import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://lifex.xgym.com.au',
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
    },
  });
}

async function verifyStaff(req: Request, adminSb: any): Promise<boolean> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser(token);
  if (error || !user) return false;
  const { data: profile } = await adminSb.from('profiles').select('is_staff').eq('id', user.id).single();
  return !!profile?.is_staff;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': 'https://lifex.xgym.com.au', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey' } });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    if (!(await verifyStaff(req, sb))) {
      return cors(JSON.stringify({ error: 'Unauthorized' }), 401);
    }

    const { action, clientId, message, subject } = await req.json();
    if (!clientId) return cors(JSON.stringify({ error: 'clientId required' }), 400);

    // ── GET STATUS ──────────────────────────────────────────────────────
    if (action === 'get_status') {
      const { data: { user }, error } = await sb.auth.admin.getUserById(clientId);
      if (error || !user) return cors(JSON.stringify({ error: 'User not found' }), 404);
      return cors(JSON.stringify({
        email: user.email,
        confirmed: !!user.email_confirmed_at,
        confirmedAt: user.email_confirmed_at,
        createdAt: user.created_at,
        lastSignIn: user.last_sign_in_at,
      }));
    }

    // ── RESEND INVITE ───────────────────────────────────────────────────
    if (action === 'resend_invite') {
      const { data: { user }, error: fetchErr } = await sb.auth.admin.getUserById(clientId);
      if (fetchErr || !user?.email) return cors(JSON.stringify({ error: 'User not found' }), 404);

      const { data: profile } = await sb.from('profiles').select('full_name,initials').eq('id', clientId).single();
      const firstName = profile?.full_name?.split(' ')[0] || '';

      // Generate invite link (does not send Supabase default email)
      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type: 'invite',
        email: user.email,
        options: {
          data: { full_name: profile?.full_name, initials: profile?.initials },
          redirectTo: 'https://lifex.xgym.com.au/index.html'
        }
      });
      if (linkErr) return cors(JSON.stringify({ error: linkErr.message }), 500);

      const inviteLink = linkData?.properties?.action_link;
      if (!inviteLink) return cors(JSON.stringify({ error: 'Could not generate invite link' }), 500);

      // Send branded invite email via Resend
      if (!RESEND_API_KEY) return cors(JSON.stringify({ error: 'Email not configured' }), 500);

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0">
    <tr><td align="center" style="padding:40px 16px">
      <table cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#08090b;border-radius:16px;overflow:hidden">
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.07)">
          <div style="display:inline-block;width:56px;height:56px;background:#f5c842;border-radius:14px;line-height:56px;font-family:Georgia,serif;font-size:26px;font-weight:900;color:#000;letter-spacing:-1px;text-align:center">LX</div>
          <div style="margin-top:12px;font-size:22px;font-weight:700;letter-spacing:4px;color:#ffffff;text-transform:uppercase">Life X</div>
          <div style="font-size:11px;color:#5a6272;letter-spacing:2px;text-transform:uppercase;margin-top:3px">Body Intelligence</div>
        </td></tr>
        <tr><td style="padding:36px 40px 28px">
          ${firstName ? `<p style="margin:0 0 18px;font-size:16px;color:#eef0f3;line-height:1.6">Hi ${firstName},</p>` : ''}
          <p style="margin:0 0 18px;font-size:15px;color:#c0c8d4;line-height:1.7">Your <strong style="color:#f5c842">Life X</strong> results portal is ready. Click below to set your password and access your DEXA scan results, body composition data, and Life X Score.</p>
          <p style="margin:0 0 32px;font-size:15px;color:#c0c8d4;line-height:1.7">This takes less than a minute.</p>
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td align="center">
              <a href="${inviteLink}" style="display:inline-block;padding:16px 40px;background:#f5c842;color:#000000;font-size:16px;font-weight:700;text-decoration:none;border-radius:8px;letter-spacing:1px;text-transform:uppercase">
                Set My Password &rarr;
              </a>
            </td></tr>
          </table>
          <p style="margin:28px 0 0;font-size:12px;color:#5a6272;line-height:1.6;text-align:center">
            Button not working? Copy and paste this link into your browser:<br>
            <a href="${inviteLink}" style="color:#f5c842;word-break:break-all">${inviteLink}</a>
          </p>
          <p style="margin:16px 0 0;font-size:12px;color:#5a6272;text-align:center">
            This link expires in <strong style="color:#8a94a6">24 hours</strong>. If it expires, contact us and we'll send a new one.
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.07)">
          <p style="margin:0 0 3px;font-size:13px;color:#5a6272;font-weight:600">The Life X Team</p>
          <p style="margin:0 0 3px;font-size:13px;color:#5a6272">XGYM Castle Hill</p>
          <p style="margin:0;font-size:13px;color:#5a6272">0424 023 601</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'Life X by XGYM <dexa@xgym.com.au>',
          to: [user.email],
          reply_to: 'dexa@xgym.com.au',
          subject: 'Your Life X account is ready — set your password',
          html,
        }),
      });
      if (!emailRes.ok) return cors(JSON.stringify({ error: 'Failed to send email' }), 500);
      return cors(JSON.stringify({ success: true }));
    }

    // ── SEND MESSAGE ────────────────────────────────────────────────────
    if (action === 'send_message') {
      if (!message) return cors(JSON.stringify({ error: 'message required' }), 400);
      if (!RESEND_API_KEY) return cors(JSON.stringify({ error: 'Email not configured' }), 500);

      const { data: { user }, error: fetchErr } = await sb.auth.admin.getUserById(clientId);
      if (fetchErr || !user?.email) return cors(JSON.stringify({ error: 'User not found' }), 404);

      const { data: profile } = await sb.from('profiles').select('full_name').eq('id', clientId).single();
      const firstName = profile?.full_name?.split(' ')[0] || '';

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4">
    <tr><td align="center" style="padding:32px 16px">
      <table cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:4px;border:1px solid #e0e0e0">
        <tr><td style="padding:28px 32px">
          ${firstName ? `<p style="margin:0 0 16px;font-size:15px;color:#222;line-height:1.7">Hi ${firstName},</p>` : ''}
          <div style="font-size:15px;color:#222;line-height:1.8;white-space:pre-wrap">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <p style="margin:24px 0 4px;font-size:15px;color:#222">Thanks!</p>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #ebebeb">
          <p style="margin:0 0 2px;font-size:13px;color:#555;font-weight:600">The Life X Team</p>
          <p style="margin:0 0 2px;font-size:13px;color:#555">XGYM Castle Hill</p>
          <p style="margin:0;font-size:13px;color:#555">phone: 0424 023 601</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'DEXA XGYM Castle Hill <dexa@xgym.com.au>',
          to: [user.email],
          bcc: ['dexa@xgym.com.au'],
          reply_to: 'dexa@xgym.com.au',
          subject: subject || 'A message from XGYM Life X',
          html,
        }),
      });
      if (!emailRes.ok) return cors(JSON.stringify({ error: 'Failed to send email' }), 500);

      // Log in client_activity
      await sb.from('client_activity').insert({ client_id: clientId, event: 'staff_message' });
      return cors(JSON.stringify({ success: true }));
    }

    return cors(JSON.stringify({ error: 'Unknown action' }), 400);
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
