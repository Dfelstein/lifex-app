import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' },
  });

  try {
    const url = new URL(req.url);
    const sex   = url.searchParams.get('sex');   // 'male' or 'female'
    const age   = parseInt(url.searchParams.get('age') || '0');
    const value = parseFloat(url.searchParams.get('value') || '0');

    if (!sex || !age) return cors(JSON.stringify({ error: 'sex and age required' }), 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Try age decade first, then broaden to ±15 years if not enough data
    const ageDecadeMin = Math.floor(age / 10) * 10;
    const ageDecadeMax = ageDecadeMin + 9;

    async function fetchVals(ageMin: number, ageMax: number) {
      const { data } = await sb
        .from('dexa_scans')
        .select('fat_pct')
        .eq('sex', sex)
        .gte('patient_age', ageMin)
        .lte('patient_age', ageMax)
        .not('fat_pct', 'is', null);
      return (data || []).map((r: any) => r.fat_pct).filter((v: any) => v != null);
    }

    let vals = await fetchVals(ageDecadeMin, ageDecadeMax);

    // Broaden if fewer than 10 scans in exact age decade
    if (vals.length < 10) {
      vals = await fetchVals(age - 15, age + 15);
    }
    // Broaden further if still not enough — use all scans for sex
    if (vals.length < 5) {
      const { data } = await sb
        .from('dexa_scans')
        .select('fat_pct')
        .eq('sex', sex)
        .not('fat_pct', 'is', null);
      vals = (data || []).map((r: any) => r.fat_pct).filter((v: any) => v != null);
    }

    if (vals.length < 3) {
      return cors(JSON.stringify({ insufficient: true, count: vals.length }));
    }

    const mean = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
    const sd   = Math.sqrt(vals.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / vals.length);

    // Percentile: what % of the database has body fat LESS THAN the user's value
    // Higher leaner = user is leaner than that % of people
    const leaner = Math.round((vals.filter((v: number) => v > value).length / vals.length) * 100);

    // Top 25% threshold
    const sorted  = [...vals].sort((a, b) => a - b);
    const top25   = sorted[Math.floor(sorted.length * 0.25)];
    const median  = sorted[Math.floor(sorted.length * 0.5)];

    return cors(JSON.stringify({
      mean:    parseFloat(mean.toFixed(1)),
      sd:      parseFloat(Math.max(sd, 2).toFixed(1)),
      count:   vals.length,
      leaner,
      top25:   parseFloat(top25.toFixed(1)),
      median:  parseFloat(median.toFixed(1)),
    }));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
