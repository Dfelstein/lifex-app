import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const META_ACCESS_TOKEN = Deno.env.get('META_ACCESS_TOKEN') || '';
const META_PIXEL_ID = '1529714340852241';

async function sha256(str: string): Promise<string> {
  if (!str) return '';
  const data = new TextEncoder().encode(str.toLowerCase().trim());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sendMetaCAPI(params: {
  eventId: string;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  value: number;
  eventTime: number;
}) {
  if (!META_ACCESS_TOKEN) return;

  const [em, ph, fn, ln] = await Promise.all([
    sha256(params.email),
    sha256(params.phone.replace(/\D/g, '')),
    sha256(params.firstName),
    sha256(params.lastName),
  ]);

  const userData: Record<string, string[]> = {};
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  if (fn) userData.fn = [fn];
  if (ln) userData.ln = [ln];

  const res = await fetch(`https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        event_name: 'Purchase',
        event_time: params.eventTime,
        action_source: 'website',
        event_source_url: 'https://xgym.com.au/booking-confirmed/',
        event_id: params.eventId,
        user_data: userData,
        custom_data: { value: params.value, currency: 'AUD' },
      }],
      access_token: META_ACCESS_TOKEN,
    }),
  });

  const resText = await res.text();
  if (!res.ok) {
    console.error('Meta CAPI error:', resText);
  } else {
    console.log('Meta CAPI success:', resText);
  }
}

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey' },
  });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Acuity sends form-encoded or JSON
    let payload: any = {};
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      payload = await req.json();
    } else {
      const text = await req.text();
      const params = new URLSearchParams(text);
      payload = Object.fromEntries(params.entries());
    }

    const action = payload.action || 'scheduled';

    // Only track new bookings and rescheduled
    if (!['scheduled', 'rescheduled'].includes(action)) {
      return cors(JSON.stringify({ ok: true, skipped: true, action }));
    }

    const appointmentId = payload.id || payload.appointmentID;

    // Fetch full appointment details from Acuity API
    const ACUITY_USER_ID = Deno.env.get('ACUITY_USER_ID') || '30827974';
    const ACUITY_API_KEY = Deno.env.get('ACUITY_API_KEY')!;
    const acuityAuth = btoa(`${ACUITY_USER_ID}:${ACUITY_API_KEY}`);

    let appointmentType = payload.type || payload.appointmentType || '';
    let clientEmail = payload.email || '';
    let clientName = `${payload.firstName || ''} ${payload.lastName || ''}`.trim();
    let datetime = payload.datetime || payload.date || new Date().toISOString();
    let price = 0;
    let phone = '';

    try {
      const apptRes = await fetch(`https://acuityscheduling.com/api/v1/appointments/${appointmentId}`, {
        headers: { 'Authorization': `Basic ${acuityAuth}` }
      });
      if (apptRes.ok) {
        const appt = await apptRes.json();
        appointmentType = appt.type || appointmentType;
        clientEmail = appt.email || clientEmail;
        clientName = `${appt.firstName || ''} ${appt.lastName || ''}`.trim() || clientName;
        datetime = appt.datetime || datetime;
        price = parseFloat(appt.price || '0') || 0;
        phone = appt.phone || '';
      }
    } catch (_) { /* use payload data as fallback */ }

    // Determine service type
    let serviceType = 'other';
    const typeLower = appointmentType.toLowerCase();
    if (typeLower.includes('dexa') || typeLower.includes('body composition') || typeLower.includes('scan')) {
      serviceType = 'dexa';
    } else if (typeLower.includes('rmr') || typeLower.includes('metabolic') || typeLower.includes('resting')) {
      serviceType = 'rmr';
    } else if (typeLower.includes('blood') || typeLower.includes('panel')) {
      serviceType = 'blood';
    } else if (typeLower.includes('bone') || typeLower.includes('densitometry')) {
      serviceType = 'bone';
    }

    // Check if attribution data already arrived (from booking-confirmed page)
    const { data: attrData } = await sb.from('booking_attribution')
      .select('utm_source,utm_medium,utm_campaign,utm_content,attributed_channel,referrer_url,landing_page')
      .eq('appointment_id', String(appointmentId))
      .single();

    // Store in marketing_conversions table
    const { error } = await sb.from('marketing_conversions').upsert({
      acuity_appointment_id: String(appointmentId),
      action,
      service_type: serviceType,
      appointment_type: appointmentType,
      client_email: clientEmail,
      client_name: clientName,
      client_phone: phone,
      price,
      booked_at: new Date(datetime).toISOString(),
      raw_payload: payload,
      // Attribution — populated if booking-confirmed page already fired
      ...(attrData || {}),
    }, { onConflict: 'acuity_appointment_id' });

    if (error) {
      console.error('DB error:', error);
      // Still return 200 so Acuity doesn't retry
    }

    // Send Meta CAPI Purchase event for new bookings only (not rescheduled)
    if (action === 'scheduled' && price > 0) {
      const [firstName, ...rest] = clientName.split(' ');
      const lastName = rest.join(' ');
      await sendMetaCAPI({
        eventId: String(appointmentId),
        email: clientEmail,
        phone,
        firstName,
        lastName,
        value: price,
        eventTime: Math.floor(Date.now() / 1000),
      }).catch(e => console.error('Meta CAPI fire error:', e));
    }

    return cors(JSON.stringify({ ok: true, action, serviceType, clientName }));
  } catch (e) {
    console.error('Webhook error:', e);
    return cors(JSON.stringify({ error: String(e) }), 200); // always 200 to Acuity
  }
});
