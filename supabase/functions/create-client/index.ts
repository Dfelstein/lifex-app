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
    const { email, firstName, lastName, existingId } = await req.json();
    if (!email) return cors(JSON.stringify({ error: 'Email required' }), 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const fullName = `${firstName || ''} ${lastName || ''}`.trim();
    const initials = `${firstName?.[0] || ''}${lastName?.[0] || ''}`.toUpperCase() || 'CL';

    // If existingId: this is a ghost account being activated — update email + send invite
    if (existingId) {
      const { error: updateErr } = await sb.auth.admin.updateUserById(existingId, { email });
      if (updateErr) return cors(JSON.stringify({ error: updateErr.message }), 500);
      // Send invite to the new email
      await sb.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName, initials } });
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
        if (users.length < 1000) return null; // last page
        page++;
      }
    };
    const existing = await findExisting();
    if (existing) {
      return cors(JSON.stringify({ success: true, clientId: existing.id, fullName: existing.user_metadata?.full_name || fullName, alreadyExists: true }));
    }

    // Create auth user and send invite email
    const { data: user, error: userErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, initials }
    });

    // If Supabase says already registered, find and return the existing user
    if (userErr) {
      if (userErr.message.toLowerCase().includes('already') || userErr.message.toLowerCase().includes('registered')) {
        const found = await findExisting();
        if (found) return cors(JSON.stringify({ success: true, clientId: found.id, fullName: found.user_metadata?.full_name || fullName, alreadyExists: true }));
      }
      return cors(JSON.stringify({ error: userErr.message }), 500);
    }

    // Profile is auto-created by the handle_new_user trigger using the metadata above
    return cors(JSON.stringify({ success: true, clientId: user.user.id, fullName }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
