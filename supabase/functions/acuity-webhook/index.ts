import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

    return cors(JSON.stringify({ ok: true, action, serviceType, clientName }));
  } catch (e) {
    console.error('Webhook error:', e);
    return cors(JSON.stringify({ error: String(e) }), 200); // always 200 to Acuity
  }
});
