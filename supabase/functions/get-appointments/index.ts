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
    // Get today's date in Sydney timezone
    const now = new Date();
    const sydney = new Date(now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${sydney.getFullYear()}-${pad(sydney.getMonth() + 1)}-${pad(sydney.getDate())}`;

    // Fetch from Acuity
    const auth = btoa(`${ACUITY_USER_ID}:${ACUITY_API_KEY}`);
    const url = `https://acuityscheduling.com/api/v1/appointments?minDate=${today}&maxDate=${today}&max=50`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Basic ${auth}` },
    });

    if (!res.ok) {
      const err = await res.text();
      return cors(JSON.stringify({ error: err }), 500);
    }

    const appointments = await res.json();

    // Sort by time
    appointments.sort((a: any, b: any) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());

    // Look up Supabase UUID for each client email
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const mapped = await Promise.all(appointments.map(async (a: any) => {
      let clientId = null;

      if (a.email) {
        const { data } = await sb.auth.admin.listUsers();
        const user = data?.users?.find((u: any) => u.email?.toLowerCase() === a.email?.toLowerCase());
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
    }));

    return cors(JSON.stringify({ date: today, appointments: mapped }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
