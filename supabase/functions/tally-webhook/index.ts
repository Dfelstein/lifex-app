const PIXEL_ID = Deno.env.get('META_PIXEL_ID')!;
const ACCESS_TOKEN = Deno.env.get('META_CONVERSIONS_API_TOKEN')!;
const GA4_MEASUREMENT_ID = Deno.env.get('GA4_MEASUREMENT_ID')!;
const GA4_API_SECRET = Deno.env.get('GA4_API_SECRET')!;

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors('', 204);

  try {
    const rawText = await req.text();
    console.log('tally raw body:', rawText.slice(0, 500));
    const body = JSON.parse(rawText);

    // Tally sends fields as an array
    const fields: { label: string; value: string }[] = body?.data?.fields || [];
    console.log('fields count:', fields.length);

    const get = (label: string) =>
      fields.find((f) => f.label?.toLowerCase().includes(label.toLowerCase()))?.value || '';

    const firstName = get('first name');
    const lastName = get('last name');
    const email = get('email');
    const phone = get('phone');
    const source = get('how did you hear');

    // Hash helper (Meta requires SHA-256 hashed PII)
    async function hash(value: string): Promise<string> {
      if (!value) return '';
      const clean = value.trim().toLowerCase();
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clean));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    // Normalize AU phone numbers: strip spaces, +, then convert leading 0 to 61
    const normalizePhone = (p: string) => {
      const stripped = p.replace(/\s+/g, '').replace(/^\+/, '');
      return stripped.startsWith('0') ? '61' + stripped.slice(1) : stripped;
    };

    const userData: Record<string, string> = {};
    if (email) userData.em = await hash(email);
    if (phone) userData.ph = await hash(normalizePhone(phone));
    if (firstName) userData.fn = await hash(firstName);
    if (lastName) userData.ln = await hash(lastName);

    const eventTime = Math.floor(Date.now() / 1000);
    const eventId = `tally_${eventTime}_${Math.random().toString(36).slice(2, 8)}`;

    const payload = {
      data: [
        {
          event_name: 'StartTrial',
          event_time: eventTime,
          event_id: eventId,
          action_source: 'website',
          user_data: userData,
          custom_data: {
            lead_source: source || 'tally_form',
          },
        },
      ],
    };

    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error('Meta API error:', JSON.stringify(metaData));
      return cors(JSON.stringify({ error: 'Meta API error', detail: metaData }), 500);
    }

    console.log('Meta response:', JSON.stringify(metaData));

    // Fire GA4 Measurement Protocol event
    const formName = body?.data?.formName || 'tally_form';
    const ga4Payload = {
      client_id: `tally.${eventTime}`,
      events: [{
        name: 'form_submission',
        params: {
          form_name: formName,
          first_name: firstName,
          engagement_time_msec: 100,
        },
      }],
    };
    const ga4Res = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${GA4_API_SECRET}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ga4Payload),
      }
    );
    const ga4Body = await ga4Res.text();
    console.log('GA4 status:', ga4Res.status);
    console.log('GA4 response:', ga4Body);

    return cors(JSON.stringify({ ok: true, events_received: metaData.events_received }));
  } catch (e) {
    console.error('tally-webhook error:', e);
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
