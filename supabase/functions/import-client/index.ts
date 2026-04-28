import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-user-jwt',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-user-jwt' },
  });

  try {
    const { firstName, lastName } = await req.json();

    if (!firstName || !lastName) {
      return cors(JSON.stringify({ error: 'firstName and lastName required' }), 400);
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const fullName = `${firstName.trim()} ${lastName.trim()}`;
    const slug = `${firstName}${lastName}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const placeholderEmail = `import.${slug}.${Date.now()}@lifex.import`;

    // Create auth user with placeholder email — no invite sent, auto-confirmed
    const initials = ((firstName.trim()[0] || '') + (lastName.trim()[0] || '')).toUpperCase();
    const { data: userData, error: userError } = await sb.auth.admin.createUser({
      email: placeholderEmail,
      email_confirm: true,
      user_metadata: { full_name: fullName, initials },
    });

    if (userError) {
      return cors(JSON.stringify({ error: userError.message }), 500);
    }

    const uid = userData.user.id;
    // Profile is auto-created by the handle_new_user trigger using user_metadata
    return cors(JSON.stringify({ id: uid, name: fullName, isGhost: true }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
