import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
    },
  });
}

function stats(vals: number[], userVal: number) {
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd   = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const sorted = [...vals].sort((a, b) => a - b);
  const top25  = sorted[Math.floor(sorted.length * 0.25)];
  const median = sorted[Math.floor(sorted.length * 0.5)];
  // For fat metrics: leaner = % of people with MORE fat than you (higher = better)
  // Caller passes higherIsBetter=false for fat, true for muscle metrics
  return {
    mean:   parseFloat(mean.toFixed(2)),
    sd:     parseFloat(Math.max(sd, 0.5).toFixed(2)),
    count:  vals.length,
    top25:  parseFloat(top25.toFixed(2)),
    median: parseFloat(median.toFixed(2)),
    // leaner: % of population with higher fat (lower is better for fat)
    leaner: Math.round((vals.filter(v => v > userVal).length / vals.length) * 100),
    // stronger: % of population with lower FFMI/ALMI (higher is better for muscle)
    stronger: Math.round((vals.filter(v => v < userVal).length / vals.length) * 100),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey' },
  });

  try {
    const url = new URL(req.url);
    const sex       = url.searchParams.get('sex');
    const age       = parseInt(url.searchParams.get('age') || '0');
    const fatValue  = parseFloat(url.searchParams.get('value') || '0');
    const ffmiValue = parseFloat(url.searchParams.get('ffmi') || '0');
    const almiValue = parseFloat(url.searchParams.get('almi') || '0');

    if (!sex || !age) return cors(JSON.stringify({ error: 'sex and age required' }), 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const ageDecadeMin = Math.floor(age / 10) * 10;
    const ageDecadeMax = ageDecadeMin + 9;

    async function fetchRows(ageMin: number, ageMax: number) {
      const { data } = await sb
        .from('dexa_scans')
        .select('fat_pct, ffmi, almi, fmi')
        .eq('sex', sex)
        .gte('patient_age', ageMin)
        .lte('patient_age', ageMax)
        .not('fat_pct', 'is', null);
      return data || [];
    }

    let rows = await fetchRows(ageDecadeMin, ageDecadeMax);
    if (rows.length < 10) rows = await fetchRows(age - 15, age + 15);
    if (rows.length < 5) {
      const { data } = await sb
        .from('dexa_scans')
        .select('fat_pct, ffmi, almi, fmi')
        .eq('sex', sex)
        .not('fat_pct', 'is', null);
      rows = data || [];
    }

    if (rows.length < 3) {
      return cors(JSON.stringify({ insufficient: true, count: rows.length }));
    }

    const fatVals  = rows.map((r: any) => r.fat_pct).filter((v: any) => v != null);
    const ffmiVals = rows.map((r: any) => r.ffmi).filter((v: any) => v != null);
    const almiVals = rows.map((r: any) => r.almi).filter((v: any) => v != null);
    const fmiVals  = rows.map((r: any) => r.fmi).filter((v: any) => v != null);

    const result: any = {
      count: rows.length,
      fat:   fatVals.length  >= 3 ? stats(fatVals,  fatValue)  : null,
      ffmi:  ffmiVals.length >= 3 ? stats(ffmiVals, ffmiValue) : null,
      almi:  almiVals.length >= 3 ? stats(almiVals, almiValue) : null,
      fmi:   fmiVals.length  >= 3 ? stats(fmiVals,  fatValue)  : null,
    };

    // Top-level aliases for backwards compat with existing guest.html code
    if (result.fat) {
      result.mean   = result.fat.mean;
      result.sd     = result.fat.sd;
      result.leaner = result.fat.leaner;
      result.top25  = result.fat.top25;
      result.median = result.fat.median;
    }

    return cors(JSON.stringify(result));
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
