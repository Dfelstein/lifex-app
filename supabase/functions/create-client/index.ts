import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

const PORTAL_URL = 'https://lifex.xgym.com.au/index.html';

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://lifex.xgym.com.au',
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-user-jwt',
    },
  });
}

async function verifyStaff(req: Request, adminSb: any): Promise<boolean> {
  const authHeader = req.headers.get('Authorization'); const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser(token);
  if (error || !user) return false;
  return !!user.app_metadata?.is_staff;
}

async function sendInviteEmail(email: string, firstName: string, inviteLink: string) {
  if (!RESEND_API_KEY) return;
  const name = firstName || 'there';
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0">
    <tr><td align="center" style="padding:40px 16px">
      <table cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#08090b;border-radius:16px;overflow:hidden">

        <!-- Header -->
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.07)">
          <div style="display:inline-block;width:56px;height:56px;background:#f5c842;border-radius:14px;line-height:56px;font-family:Georgia,serif;font-size:26px;font-weight:900;color:#000;letter-spacing:-1px;text-align:center">LX</div>
          <div style="margin-top:12px;font-size:22px;font-weight:700;letter-spacing:4px;color:#ffffff;text-transform:uppercase">Life X</div>
          <div style="font-size:11px;color:#5a6272;letter-spacing:2px;text-transform:uppercase;margin-top:3px">Body Intelligence</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:36px 40px 28px">
          <p style="margin:0 0 18px;font-size:16px;color:#eef0f3;line-height:1.6">Hi ${name},</p>
          <p style="margin:0 0 18px;font-size:15px;color:#c0c8d4;line-height:1.7">Your <strong style="color:#f5c842">Life X</strong> results portal is ready. Click below to set your password and access your DEXA scan results, body composition data, and Life X Score.</p>
          <p style="margin:0 0 32px;font-size:15px;color:#c0c8d4;line-height:1.7">This takes less than a minute.</p>

          <!-- CTA Button -->
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

        <!-- Footer -->
        <tr><td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.07)">
          <p style="margin:0 0 3px;font-size:13px;color:#5a6272;font-weight:600">The Life X Team</p>
          <p style="margin:0 0 3px;font-size:13px;color:#5a6272">XGYM Castle Hill</p>
          <p style="margin:0;font-size:13px;color:#5a6272">0424 023 601</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'Life X by XGYM <dexa@xgym.com.au>',
      to: [email],
      reply_to: 'dexa@xgym.com.au',
      subject: 'Your Life X account is ready — set your password',
      html,
    }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': 'https://lifex.xgym.com.au', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-user-jwt' } });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    if (!(await verifyStaff(req, sb))) {
      return cors(JSON.stringify({ error: 'Unauthorized' }), 401);
    }

    const { email, firstName, lastName, existingId } = await req.json();
    if (!email) return cors(JSON.stringify({ error: 'Email required' }), 400);

    const fullName = `${firstName || ''} ${lastName || ''}`.trim();
    const initials = `${firstName?.[0] || ''}${lastName?.[0] || ''}`.toUpperCase() || 'CL';

    // If existingId: this is a ghost account being activated — update email + send invite
    if (existingId) {
      const { error: updateErr } = await sb.auth.admin.updateUserById(existingId, { email });
      if (updateErr) return cors(JSON.stringify({ error: updateErr.message }), 500);

      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { data: { full_name: fullName, initials }, redirectTo: PORTAL_URL }
      });
      if (!linkErr && linkData?.properties?.action_link) {
        await sendInviteEmail(email, firstName, linkData.properties.action_link);
      }
      return cors(JSON.stringify({ success: true, clientId: existingId, fullName }));
    }

    // Check if user already exists — page through all users to be safe
    const findExisting = async () => {
      let page = 1;
      while (true) {
        const { data } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        const users = data?.users || [];
        const found = users.find((u: any) => u.email?.toLowerCase() === email.toLowerCase());
        if (found) return found;
        if (users.length < 1000) return null;
        page++;
      }
    };
    const existing = await findExisting();
    if (existing) {
      return cors(JSON.stringify({ success: true, clientId: existing.id, fullName: existing.user_metadata?.full_name || fullName, alreadyExists: true }));
    }

    // Generate invite link and send our own branded email
    const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { data: { full_name: fullName, initials }, redirectTo: PORTAL_URL }
    });

    if (linkErr) {
      // Fallback: if already registered error, find and return existing
      if (linkErr.message.toLowerCase().includes('already') || linkErr.message.toLowerCase().includes('registered')) {
        const found = await findExisting();
        if (found) return cors(JSON.stringify({ success: true, clientId: found.id, fullName: found.user_metadata?.full_name || fullName, alreadyExists: true }));
      }
      return cors(JSON.stringify({ error: linkErr.message }), 500);
    }

    // Send branded invite email
    if (linkData?.properties?.action_link) {
      await sendInviteEmail(email, firstName, linkData.properties.action_link);
    }

    // Profile is auto-created by the handle_new_user trigger using the metadata above
    return cors(JSON.stringify({ success: true, clientId: linkData!.user.id, fullName }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
