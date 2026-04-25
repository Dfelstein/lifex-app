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
  if (req.method === 'OPTIONS') return cors('', 204);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return cors(JSON.stringify({ error: 'Unauthorized' }), 401);

    // Verify the caller is a staff member
    const userClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: { user }, error: userErr } = await userClient.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (userErr || !user) return cors(JSON.stringify({ error: 'Unauthorized' }), 401);

    const { data: profile } = await userClient
      .from('profiles')
      .select('is_staff')
      .eq('id', user.id)
      .single();

    if (!profile?.is_staff) return cors(JSON.stringify({ error: 'Forbidden' }), 403);

    const { path } = await req.json();
    if (!path) return cors(JSON.stringify({ error: 'path required' }), 400);

    const { data, error } = await userClient.storage
      .from('scans')
      .createSignedUrl(path, 3600);

    if (error || !data?.signedUrl) {
      return cors(JSON.stringify({ error: error?.message || 'Failed to sign URL' }), 500);
    }

    return cors(JSON.stringify({ signedUrl: data.signedUrl }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
