import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const R2_ENDPOINT = 'https://20a98cdbaaa18ad93be74da2a7a145aa.r2.cloudflarestorage.com';
const R2_BUCKET = 'lifex-app';

const aws = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
  service: 's3',
  region: 'auto',
});

// Signed R2 URL if the file has been moved to R2, otherwise null
async function r2SignedUrl(key: string, expirySeconds: number): Promise<string | null> {
  try {
    const url = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    const head = await aws.fetch(url.toString(), { method: 'HEAD' });
    if (!head.ok) return null;
    url.searchParams.set('X-Amz-Expires', String(expirySeconds));
    const signed = await aws.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
    return signed.url;
  } catch {
    return null;
  }
}

function cors(body: string, status = 200) {
  // A 204 response must have a null body, or Deno throws and the preflight 500s
  return new Response(status === 204 ? null : body, {
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
    if (!payload?.sub) return cors(JSON.stringify({ error: 'Unauthorized' }), 401);

    const isStaff = Boolean(payload?.app_metadata?.is_staff);
    const userId = payload.sub as string;

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { path } = await req.json();
    if (!path) return cors(JSON.stringify({ error: 'path required' }), 400);

    // Staff can access any file; clients can only access their own (paths are {userId}/filename)
    if (!isStaff && !path.startsWith(userId + '/')) {
      return cors(JSON.stringify({ error: 'Forbidden' }), 403);
    }

    // R2 first, then Supabase Storage for files not yet moved
    const r2Url = await r2SignedUrl(path, 3600);
    if (r2Url) return cors(JSON.stringify({ signedUrl: r2Url }));

    const { data, error } = await adminClient.storage.from('scans').createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) return cors(JSON.stringify({ error: error?.message || 'Failed to sign URL' }), 500);

    return cors(JSON.stringify({ signedUrl: data.signedUrl }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
