import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    const { email, firstName, lastName } = await req.json();
    if (!email) return cors(JSON.stringify({ error: 'Email required' }), 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const fullName = `${firstName || ''} ${lastName || ''}`.trim();
    const initials = `${firstName?.[0] || ''}${lastName?.[0] || ''}`.toUpperCase() || 'CL';

    // Create auth user and send invite email
    const { data: user, error: userErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, initials }
    });

    if (userErr) return cors(JSON.stringify({ error: userErr.message }), 500);

    // Profile is auto-created by the handle_new_user trigger using the metadata above
    return cors(JSON.stringify({ success: true, clientId: user.user.id, fullName }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
