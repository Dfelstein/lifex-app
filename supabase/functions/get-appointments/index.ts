import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ACUITY_USER_ID = Deno.env.get('ACUITY_USER_ID')!;
const ACUITY_API_KEY = Deno.env.get('ACUITY_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

async function verifyStaffDebug(req: Request): Promise<{ ok: boolean; reason: string }> {
  const authHeader = req.headers.get('Authorization'); const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, reason: 'no_auth_header' };
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser(token);
  if (error) return { ok: false, reason: 'getUser_error:' + error.message };
  if (!user) return { ok: false, reason: 'no_user' };
  if (!user.app_metadata?.is_staff) return { ok: false, reason: 'not_staff' };
  return { ok: true, reason: 'ok' };
}

async function verifyStaff(req: Request): Promise<boolean> {
  const result = await verifyStaffDebug(req);
  return result.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': 'https://lifex.xgym.com.au', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-user-jwt' } });

  try {
    const authResult = await verifyStaffDebug(req);
    if (!authResult.ok) return cors(JSON.stringify({ error: 'Unauthorized', reason: authResult.reason }), 401);

    // Allow ?date=YYYY-MM-DD param, otherwise use today in Sydney time
    const urlParams = new URL(req.url).searchParams;
    let targetDate = urlParams.get('date') || '';

    const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });

    if (!targetDate) {
      targetDate = dateFmt.format(new Date());
    }

    // Fetch from Acuity
    const auth = btoa(`${ACUITY_USER_ID}:${ACUITY_API_KEY}`);
    const url = `https://acuityscheduling.com/api/v1/appointments?minDate=${targetDate}&maxDate=${targetDate}&max=200`;

    const res = await fetch(url, { headers: { 'Authorization': `Basic ${auth}` } });

    if (!res.ok) {
      const err = await res.text();
      return cors(JSON.stringify({ error: err }), 500);
    }

    const appointments = await res.json();

    if (!Array.isArray(appointments)) {
      return cors(JSON.stringify({ error: 'Acuity error', raw: appointments }), 500);
    }

    appointments.sort((a: any, b: any) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());

    // Look up Supabase UUID for each client — fetch all users once
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data: usersData } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const users = usersData?.users || [];

    const mapped = appointments.map((a: any) => {
      let clientId = null;
      let emailConfirmed = false;
      if (a.email) {
        const user = users.find((u: any) => u.email?.toLowerCase() === a.email?.toLowerCase());
        if (user) {
          clientId = user.id;
          emailConfirmed = !!user.email_confirmed_at;
        }
      }
      return {
        id: a.id,
        firstName: a.firstName,
        lastName: a.lastName,
        email: a.email,
        time: a.time,
        datetime: a.datetime,
        type: a.type,
        duration: a.duration,
        clientId,
        emailConfirmed,
      };
    });

    return cors(JSON.stringify({ date: targetDate, appointments: mapped }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
