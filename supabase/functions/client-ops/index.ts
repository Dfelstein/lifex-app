import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });

  try {
    const { action, clientId, message, subject } = await req.json();
    if (!clientId) return cors(JSON.stringify({ error: 'clientId required' }), 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

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
      const { error: inviteErr } = await sb.auth.admin.inviteUserByEmail(user.email, {
        data: { full_name: profile?.full_name, initials: profile?.initials }
      });
      if (inviteErr) return cors(JSON.stringify({ error: inviteErr.message }), 500);
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
