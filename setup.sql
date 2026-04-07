-- ══════════════════════════════════════════════════
-- LIFE X APP — DATABASE SETUP
-- Run this in your Supabase SQL Editor (supabase.com → SQL Editor)
-- ══════════════════════════════════════════════════

-- ── PROFILES (extends auth.users) ──
create table if not exists public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  full_name     text    not null default 'Client',
  initials      text    not null default 'CL',
  member_level  text    not null default 'Standard',
  points        integer not null default 0,
  is_staff      boolean not null default false,
  sex           text,
  created_at    timestamptz not null default now()
);

-- Auto-create profile row when a new user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, initials, is_staff)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'initials',  upper(left(split_part(new.email,'@',1), 2))),
    coalesce((new.raw_user_meta_data->>'is_staff')::boolean, false)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── DEXA SCANS ──
create table if not exists public.dexa_scans (
  id               uuid    default gen_random_uuid() primary key,
  client_id        uuid    references auth.users(id) on delete cascade not null,
  scan_date        date    not null,
  scan_number      integer,
  fat_pct          numeric,
  fat_g            integer,
  lean_g           integer,
  total_g          integer,
  bmd              numeric,
  t_score          numeric,
  z_score          numeric,
  pr_pct           numeric,
  vat_g            integer,
  android_fat_pct  numeric,
  gynoid_fat_pct   numeric,
  ag_ratio         numeric,
  created_at       timestamptz default now()
);

-- ── BLOOD PANELS ──
create table if not exists public.blood_panels (
  id          uuid default gen_random_uuid() primary key,
  client_id   uuid references auth.users(id) on delete cascade not null,
  panel_date  date not null,
  lab_name    text default '',
  created_at  timestamptz default now()
);

create table if not exists public.blood_markers (
  id           uuid    default gen_random_uuid() primary key,
  panel_id     uuid    references public.blood_panels(id) on delete cascade not null,
  category     text    not null default 'Other',
  name         text    not null,
  value        numeric not null,
  unit         text    not null default '',
  display_min  numeric not null default 0,
  display_max  numeric not null default 100,
  ref_min      numeric not null,
  ref_max      numeric not null,
  status       text    not null default 'normal',
  created_at   timestamptz default now()
);

-- ── HORMONE PANELS ──
create table if not exists public.hormone_panels (
  id          uuid default gen_random_uuid() primary key,
  client_id   uuid references auth.users(id) on delete cascade not null,
  panel_date  date not null,
  created_at  timestamptz default now()
);

create table if not exists public.hormone_markers (
  id           uuid    default gen_random_uuid() primary key,
  panel_id     uuid    references public.hormone_panels(id) on delete cascade not null,
  name         text    not null,
  value        numeric not null,
  unit         text    not null default '',
  display_min  numeric not null default 0,
  display_max  numeric not null default 100,
  ref_min      numeric not null,
  ref_max      numeric not null,
  status       text    not null default 'normal',
  note         text    default '',
  created_at   timestamptz default now()
);

-- ── RMR TESTS ──
create table if not exists public.rmr_tests (
  id           uuid    default gen_random_uuid() primary key,
  client_id    uuid    references auth.users(id) on delete cascade not null,
  test_date    date    not null,
  kcal         integer not null,
  kj           integer,
  fat_pct      numeric,
  glucose_pct  numeric,
  feo2         numeric,
  pop_min      integer,
  pop_max      integer,
  created_at   timestamptz default now()
);

-- ══════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════

-- Helper function: is current user a staff member?
create or replace function public.is_staff()
returns boolean language sql security definer stable as $$
  select coalesce((select is_staff from public.profiles where id = auth.uid()), false);
$$;

-- PROFILES
alter table public.profiles enable row level security;
create policy "profiles_select" on public.profiles for select using (id = auth.uid() or is_staff());
create policy "profiles_insert" on public.profiles for insert with check (is_staff());
create policy "profiles_update" on public.profiles for update using (id = auth.uid() or is_staff());

-- DEXA SCANS
alter table public.dexa_scans enable row level security;
create policy "dexa_select" on public.dexa_scans for select using (client_id = auth.uid() or is_staff());
create policy "dexa_insert" on public.dexa_scans for insert with check (is_staff());
create policy "dexa_update" on public.dexa_scans for update using (is_staff());
create policy "dexa_delete" on public.dexa_scans for delete using (is_staff());

-- BLOOD PANELS
alter table public.blood_panels enable row level security;
create policy "bp_select" on public.blood_panels for select using (client_id = auth.uid() or is_staff());
create policy "bp_insert" on public.blood_panels for insert with check (is_staff());
create policy "bp_update" on public.blood_panels for update using (is_staff());
create policy "bp_delete" on public.blood_panels for delete using (is_staff());

alter table public.blood_markers enable row level security;
create policy "bm_select" on public.blood_markers for select using (
  exists (select 1 from public.blood_panels where id = panel_id and (client_id = auth.uid() or is_staff()))
);
create policy "bm_insert" on public.blood_markers for insert with check (is_staff());
create policy "bm_update" on public.blood_markers for update using (is_staff());
create policy "bm_delete" on public.blood_markers for delete using (is_staff());

-- HORMONE PANELS
alter table public.hormone_panels enable row level security;
create policy "hp_select" on public.hormone_panels for select using (client_id = auth.uid() or is_staff());
create policy "hp_insert" on public.hormone_panels for insert with check (is_staff());
create policy "hp_update" on public.hormone_panels for update using (is_staff());
create policy "hp_delete" on public.hormone_panels for delete using (is_staff());

alter table public.hormone_markers enable row level security;
create policy "hm_select" on public.hormone_markers for select using (
  exists (select 1 from public.hormone_panels where id = panel_id and (client_id = auth.uid() or is_staff()))
);
create policy "hm_insert" on public.hormone_markers for insert with check (is_staff());
create policy "hm_update" on public.hormone_markers for update using (is_staff());
create policy "hm_delete" on public.hormone_markers for delete using (is_staff());

-- RMR TESTS
alter table public.rmr_tests enable row level security;
create policy "rmr_select" on public.rmr_tests for select using (client_id = auth.uid() or is_staff());
create policy "rmr_insert" on public.rmr_tests for insert with check (is_staff());
create policy "rmr_update" on public.rmr_tests for update using (is_staff());
create policy "rmr_delete" on public.rmr_tests for delete using (is_staff());

-- Marketing conversions (Acuity webhook bookings)
CREATE TABLE IF NOT EXISTS marketing_conversions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  acuity_appointment_id text UNIQUE,
  action text,
  service_type text,
  appointment_type text,
  client_email text,
  client_name text,
  booked_at timestamptz,
  raw_payload jsonb,
  created_at timestamptz DEFAULT now()
);
GRANT ALL ON marketing_conversions TO anon, authenticated, service_role;
