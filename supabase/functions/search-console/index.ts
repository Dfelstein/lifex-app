const GOOGLE_SA_JSON = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') || '';
const SITE_URL = Deno.env.get('SEARCH_CONSOLE_SITE') || 'sc-domain:xgym.com.au';

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
    },
  });
}

function b64url(s: string) {
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const signing = `${header}.${payload}`;
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyBytes = Uint8Array.from(atob(pem), (c: string) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signing));
  const sig = b64url(String.fromCharCode(...new Uint8Array(sigBytes)));
  const jwt = `${signing}.${sig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function scQuery(token: string, body: any) {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey' },
  });

  try {
    if (!GOOGLE_SA_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

    const sa = JSON.parse(GOOGLE_SA_JSON);
    const token = await getAccessToken(sa);

    const end = new Date();
    const start = new Date(end.getTime() - 28 * 24 * 60 * 60 * 1000);
    const endDate = end.toISOString().split('T')[0];
    const startDate = start.toISOString().split('T')[0];

    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - 28 * 24 * 60 * 60 * 1000);
    const prevEndDate = prevEnd.toISOString().split('T')[0];
    const prevStartDate = prevStart.toISOString().split('T')[0];

    const [queries, pages, prevQueries] = await Promise.all([
      scQuery(token, { startDate, endDate, dimensions: ['query'], rowLimit: 25, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }),
      scQuery(token, { startDate, endDate, dimensions: ['page'], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }),
      scQuery(token, { startDate: prevStartDate, endDate: prevEndDate, dimensions: ['query'], rowLimit: 25 }),
    ]);

    // Build prev period lookup for click comparison
    const prevMap: Record<string, number> = {};
    (prevQueries.rows || []).forEach((r: any) => { prevMap[r.keys[0]] = r.clicks; });

    // Add delta to each query row
    const enrichedQueries = (queries.rows || []).map((r: any) => ({
      ...r,
      prev_clicks: prevMap[r.keys[0]] || 0,
      click_delta: (r.clicks || 0) - (prevMap[r.keys[0]] || 0),
    }));

    return cors(JSON.stringify({
      period: { start: startDate, end: endDate },
      prev_period: { start: prevStartDate, end: prevEndDate },
      queries: enrichedQueries,
      pages: pages.rows || [],
    }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
