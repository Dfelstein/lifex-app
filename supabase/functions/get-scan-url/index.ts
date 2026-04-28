import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

function decodeJwt(token: string): any {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors('', 204);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return cors(JSON.stringify({ error: 'Unauthorized' }), 401);
    const payload = decodeJwt(authHeader.slice(7));
    if (!payload?.app_metadata?.is_staff) return cors(JSON.stringify({ error: 'Forbidden' }), 403);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { path } = await req.json();
    if (!path) return cors(JSON.stringify({ error: 'path required' }), 400);

    const { data, error } = await adminClient.storage.from('scans').createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) return cors(JSON.stringify({ error: error?.message || 'Failed to sign URL' }), 500);

    return cors(JSON.stringify({ signedUrl: data.signedUrl }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
