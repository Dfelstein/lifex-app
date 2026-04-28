import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function cors(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-user-jwt',
    },
  });
}

// Zoho Forms sends field labels and values — try multiple possible field name variations
function extract(data: Record<string, any>, ...keys: string[]): string | null {
  for (const key of keys) {
    const lower = key.toLowerCase();
    for (const k of Object.keys(data)) {
      if (k.toLowerCase() === lower || k.toLowerCase().replace(/[\s_-]/g, '') === lower.replace(/[\s_-]/g, '')) {
        const v = data[k];
        if (v !== null && v !== undefined && v !== '') return String(v).trim();
      }
    }
  }
  return null;
}

// Normalise a DOB string to YYYY-MM-DD
function normDate(raw: string | null): string | null {
  if (!raw) return null;
  // Handle DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
  const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const ymd = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-user-jwt' },
    });
  }

  try {
    let payload: any;

    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      payload = await req.json();
    } else {
      // Zoho Forms sometimes sends application/x-www-form-urlencoded
      const text = await req.text();
      try {
        payload = JSON.parse(text);
      } catch {
        const params = new URLSearchParams(text);
        payload = Object.fromEntries(params.entries());
      }
    }

    // Zoho Forms wraps entries in various shapes — flatten to a key/value map
    let fields: Record<string, any> = {};
    if (payload.formData) {
      fields = payload.formData;
    } else if (Array.isArray(payload.entries)) {
      for (const entry of payload.entries) fields = { ...fields, ...entry };
    } else {
      fields = payload;
    }

    // Extract standard intake fields — covers common Zoho Forms field label variations
    const firstName = extract(fields,
      'First Name', 'firstname', 'first_name', 'Given Name', 'givenname');
    const lastName = extract(fields,
      'Last Name', 'lastname', 'last_name', 'Surname', 'Family Name', 'familyname');
    const email = extract(fields, 'Email', 'email_address', 'Email Address');
    const phone = extract(fields,
      'Phone', 'phone_number', 'Phone Number', 'Mobile', 'Mobile Number', 'Contact Number');
    const dobRaw = extract(fields,
      'Date of Birth', 'dob', 'DOB', 'Birthday', 'Birth Date', 'birthdate');
    const dob = normDate(dobRaw);
    const address = extract(fields,
      'Address', 'Street Address', 'Home Address', 'Residential Address');
    const suburb = extract(fields, 'Suburb', 'City', 'Town');
    const state = extract(fields, 'State', 'Province');
    const postcode = extract(fields, 'Postcode', 'Post Code', 'Zip', 'Zip Code');
    const sex = extract(fields, 'Sex', 'Gender', 'Biological Sex');

    // Build full name and address
    const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;
    const fullAddress = [address, suburb, state, postcode].filter(Boolean).join(', ') || null;

    if (!fullName && !email) {
      return cors(JSON.stringify({ error: 'Could not extract name or email from submission', fields: Object.keys(fields) }), 400);
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Try to match existing profile by email, then name
    let profileId: string | null = null;

    if (email) {
      // Check auth.users for matching email
      const { data: { users } } = await sb.auth.admin.listUsers();
      const match = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
      if (match) profileId = match.id;
    }

    if (!profileId && fullName) {
      // Try to match profile by name
      const nameParts = fullName.split(' ');
      const { data: profiles } = await sb
        .from('profiles')
        .select('id, full_name')
        .ilike('full_name', `%${nameParts[0]}%`);

      if (profiles && profiles.length === 1) {
        profileId = profiles[0].id;
      } else if (profiles && profiles.length > 1 && nameParts.length > 1) {
        const exact = profiles.find(p =>
          p.full_name?.toLowerCase() === fullName.toLowerCase()
        );
        if (exact) profileId = exact.id;
      }
    }

    // Build the profile update payload (only include non-null values)
    const update: Record<string, any> = {};
    if (fullName) update.full_name = fullName;
    if (dob) update.dob = dob;
    if (phone) update.phone = phone;
    if (fullAddress) update.address = fullAddress;
    if (sex) update.sex = sex?.toLowerCase().startsWith('f') ? 'female' : 'male';

    if (profileId) {
      // Update existing profile
      const { error } = await sb.from('profiles').update(update).eq('id', profileId);
      if (error) return cors(JSON.stringify({ error: error.message }), 500);
      return cors(JSON.stringify({ success: true, action: 'updated', profileId }));
    } else {
      // Store as pending intake entry for staff to review and link
      const { error } = await sb.from('zoho_intake_pending').upsert({
        full_name: fullName,
        email,
        phone,
        dob,
        address: fullAddress,
        sex: sex?.toLowerCase().startsWith('f') ? 'female' : 'male',
        raw_fields: fields,
        received_at: new Date().toISOString(),
      }, { onConflict: 'email' });

      if (error) return cors(JSON.stringify({ error: error.message }), 500);
      return cors(JSON.stringify({ success: true, action: 'queued', note: 'No matching profile found — stored for manual review' }));
    }
  } catch (e) {
    return cors(JSON.stringify({ error: String(e) }), 500);
  }
});
