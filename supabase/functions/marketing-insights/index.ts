import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_KEY')!;

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

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString();
    const sixMonthsAgo   = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString();

    // Scans this month
    const { count: dexaThisMonth } = await sb.from('dexa_scans')
      .select('*', { count: 'exact', head: true })
      .gte('scan_date', thisMonthStart);

    const { count: dexaLastMonth } = await sb.from('dexa_scans')
      .select('*', { count: 'exact', head: true })
      .gte('scan_date', lastMonthStart)
      .lte('scan_date', lastMonthEnd);

    const { count: rmrThisMonth } = await sb.from('rmr_tests')
      .select('*', { count: 'exact', head: true })
      .gte('test_date', thisMonthStart);

    const { count: bloodThisMonth } = await sb.from('blood_panels')
      .select('*', { count: 'exact', head: true })
      .gte('panel_date', thisMonthStart);

    // Total clients
    const { count: totalClients } = await sb.from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('is_staff', false);

    // New clients this month
    const { count: newClientsThisMonth } = await sb.from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('is_staff', false)
      .gte('created_at', thisMonthStart);

    // Guest leads (unmatched zoho intakes = warm leads who used the free tool but haven't booked)
    const { count: pendingLeads } = await sb.from('zoho_intake_pending')
      .select('*', { count: 'exact', head: true });

    // Monthly scan trend (last 6 months)
    const { data: scanTrend } = await sb.from('dexa_scans')
      .select('scan_date')
      .gte('scan_date', sixMonthsAgo)
      .order('scan_date', { ascending: true });

    // Group by month
    const monthCounts: Record<string, number> = {};
    (scanTrend || []).forEach((s: any) => {
      const key = s.scan_date.substring(0, 7);
      monthCounts[key] = (monthCounts[key] || 0) + 1;
    });

    // Revenue from marketing_conversions (actual Acuity bookings)
    const { data: convData } = await sb.from('marketing_conversions')
      .select('price, service_type')
      .eq('action', 'scheduled')
      .gte('booked_at', thisMonthStart);

    const actualRevenue = (convData || []).reduce((s: number, r: any) => s + (parseFloat(r.price) || 0), 0);

    // Estimated revenue from scan counts
    const estimatedRevenue = ((dexaThisMonth || 0) * 149) + ((rmrThisMonth || 0) * 160);
    const estimatedRevenueLast = ((dexaLastMonth || 0) * 149);

    const internalData = {
      dexa_scans_this_month: dexaThisMonth || 0,
      dexa_scans_last_month: dexaLastMonth || 0,
      rmr_tests_this_month: rmrThisMonth || 0,
      blood_panels_this_month: bloodThisMonth || 0,
      total_clients: totalClients || 0,
      new_clients_this_month: newClientsThisMonth || 0,
      warm_leads_pending: pendingLeads || 0,
      monthly_scan_trend: monthCounts,
      target_weekly_dexa: 25,
      current_month_day: now.getDate(),
      days_in_month: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
      estimated_revenue_this_month_aud: estimatedRevenue,
      estimated_revenue_last_month_aud: estimatedRevenueLast,
      actual_tracked_revenue_aud: actualRevenue,
      revenue_on_track: estimatedRevenue >= (estimatedRevenueLast * 0.9),
    };

    // Also accept external data passed in the request body
    let externalData = {};
    try {
      const body = await req.json();
      externalData = body?.external || {};
    } catch (_) { /* no body */ }

    const allData = { ...internalData, ...externalData };

    // Call Claude for insights
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `You are a marketing strategist for Life X, a health clinic in Castle Hill, Sydney NSW.

Services: DEXA body composition scans ($149), RMR metabolic testing ($160), blood panels.
Target customer: health-conscious adults who care deeply about their body. They are NOT window shoppers — they buy on quality and data, not discounts.
Best content: educational posts about training, body composition, and DEXA data. Before/after comparisons work but haven't been used lately. Promos/discounts don't convert well.
Social: Instagram (synced to Facebook), YouTube.
Primary conversion goal: DEXA scan bookings (direct to Acuity). These clients often convert to personal training clients or gym memberships after their scan.
Wednesday team meetings generate great native video content when patients present to other patients.
Target: ~25 DEXA scans per week. Target monthly revenue: ~$14,875 (25 scans/wk × 4.3 × $149).
Pricing: DEXA $149, RMR $160, Blood panels via Square (price varies).

Current data:
${JSON.stringify(allData, null, 2)}

Based on this data, respond ONLY with valid JSON in this exact format:
{
  "summary": "2-3 sentence overview of where things stand this month",
  "focus_areas": [
    {"title": "...", "description": "...", "action": "...", "priority": "high|medium|low"}
  ],
  "content_ideas": [
    {"title": "...", "format": "Reel|Story|YouTube|Carousel|Post", "hook": "...", "why_it_works": "...", "cta": "..."}
  ],
  "quick_wins": [
    {"title": "...", "action": "...", "expected_impact": "..."}
  ],
  "watch_out": "One thing to be aware of this week"
}

Provide exactly 3 focus areas, 4 content ideas, and 2 quick wins. Be specific to Life X, not generic marketing advice.`
        }]
      }),
    });

    const ai = await response.json();
    const text = ai.content?.[0]?.text || '{}';

    let insights: any = {};
    try {
      const match = text.match(/\{[\s\S]*\}/);
      insights = match ? JSON.parse(match[0]) : {};
    } catch (_) {
      insights = { summary: 'Unable to generate insights at this time.', focus_areas: [], content_ideas: [], quick_wins: [] };
    }

    return cors(JSON.stringify({ data: allData, insights }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
