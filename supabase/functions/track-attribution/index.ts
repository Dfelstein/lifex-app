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

function classifyChannel(source: string, medium: string): string {
  if (!source) return 'direct';
  source = source.toLowerCase();
  medium = (medium || '').toLowerCase();
  if (source === 'google' && ['cpc', 'paid', 'ppc', 'paidsearch'].includes(medium)) return 'paid_search';
  if (source === 'google' || source === 'bing' || source === 'duckduckgo') return 'seo';
  if (['facebook', 'instagram', 'meta'].includes(source) && ['cpc', 'paid', 'ppc'].includes(medium)) return 'paid_social';
  if (['facebook', 'instagram', 'meta', 'social', 'tiktok'].includes(source)) return 'organic_social';
  if (medium === 'email') return 'email';
  if (medium === 'referral' || source === 'referral') return 'referral';
  return 'other';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey' },
  });

  try {
    const body = await req.json();
    const {
      appointment_id,
      utm_source, utm_medium, utm_campaign, utm_content,
      referrer, landing_page, landed_at,
    } = body;

    const channel = classifyChannel(utm_source || '', utm_medium || '');

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const attribution = {
      utm_source:         utm_source    || null,
      utm_medium:         utm_medium    || null,
      utm_campaign:       utm_campaign  || null,
      utm_content:        utm_content   || null,
      attributed_channel: channel,
      referrer_url:       referrer      || null,
      landing_page:       landing_page  || null,
    };

    // Always store in booking_attribution so we have a record
    if (appointment_id) {
      await sb.from('booking_attribution').upsert(
        { appointment_id: String(appointment_id), ...attribution },
        { onConflict: 'appointment_id' }
      );

      // Also update marketing_conversions if the webhook has already fired
      await sb.from('marketing_conversions')
        .update(attribution)
        .eq('acuity_appointment_id', String(appointment_id));
    }

    return cors(JSON.stringify({ ok: true, channel }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
