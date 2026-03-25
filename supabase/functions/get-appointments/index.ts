import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ACUITY_USER_ID = Deno.env.get('ACUITY_USER_ID')!;
const ACUITY_API_KEY = Deno.env.get('ACUITY_API_KEY')!;
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
    const pad = (n: number) => String(n).padStart(2, '0');

    // Allow ?date=YYYY-MM-DD param, otherwise use today in Sydney time
    const urlParams = new URL(req.url).searchParams;
    let targetDate = urlParams.get('date') || '';

    if (!targetDate) {
      const now = new Date();
      const sydney = new Date(now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));
      targetDate = `${sydney.getFullYear()}-${pad(sydney.getMonth() + 1)}-${pad(sydney.getDate())}`;
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

    // Filter strictly to the target date in AEST
    const filtered = appointments.filter((a: any) => {
      if (!a.datetime) return false;
      const apptSydney = new Date(new Date(a.datetime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));
      const apptDateStr = `${apptSydney.getFullYear()}-${pad(apptSydney.getMonth()+1)}-${pad(apptSydney.getDate())}`;
      return apptDateStr === targetDate;
    });

    filtered.sort((a: any, b: any) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());

    // Look up Supabase UUID for each client — fetch all users once
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data: usersData } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const users = usersData?.users || [];

    const mapped = filtered.map((a: any) => {
      let clientId = null;
      if (a.email) {
        const user = users.find((u: any) => u.email?.toLowerCase() === a.email?.toLowerCase());
        if (user) clientId = user.id;
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
      };
    });

    return cors(JSON.stringify({ date: targetDate, appointments: mapped }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
