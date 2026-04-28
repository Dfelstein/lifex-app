import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export async function verifyStaff(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return false;
  const { data: profile } = await sb.from('profiles')
    .select('is_staff')
    .eq('id', user.id)
    .single();
  return !!profile?.is_staff;
}

export function corsHeaders(origin = 'https://lifex.xgym.com.au') {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  };
}

export function cors(body: string, status = 200) {
  return new Response(body, { status, headers: corsHeaders() });
}

export function preflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
