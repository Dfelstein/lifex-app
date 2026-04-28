-- ═══════════════════════════════════════════════════
-- Life X Security — Enable RLS on all health tables
-- Run this in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════

-- Helper: stable function so PostgreSQL caches the
-- is_staff lookup once per query, not once per row
CREATE OR REPLACE FUNCTION public.is_staff_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COALESCE(
    (SELECT is_staff FROM public.profiles WHERE id = auth.uid()),
    false
  )
$$;

-- ── Enable RLS ──────────────────────────────────────
ALTER TABLE public.dexa_scans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rmr_tests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blood_panels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blood_markers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hormone_panels      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hormone_markers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_ins           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_activity     ENABLE ROW LEVEL SECURITY;

-- ── Drop any old policies first ──────────────────────
DO $$ BEGIN
  DROP POLICY IF EXISTS "owner or staff" ON public.dexa_scans;
  DROP POLICY IF EXISTS "owner or staff" ON public.rmr_tests;
  DROP POLICY IF EXISTS "owner or staff" ON public.blood_panels;
  DROP POLICY IF EXISTS "owner or staff" ON public.blood_markers;
  DROP POLICY IF EXISTS "owner or staff" ON public.hormone_panels;
  DROP POLICY IF EXISTS "owner or staff" ON public.hormone_markers;
  DROP POLICY IF EXISTS "owner or staff" ON public.check_ins;
  DROP POLICY IF EXISTS "owner or staff" ON public.client_activity;
END $$;

-- ── Tables with direct client_id column ─────────────
CREATE POLICY "owner or staff" ON public.dexa_scans
  FOR ALL USING (client_id = auth.uid() OR is_staff_user());

CREATE POLICY "owner or staff" ON public.rmr_tests
  FOR ALL USING (client_id = auth.uid() OR is_staff_user());

CREATE POLICY "owner or staff" ON public.blood_panels
  FOR ALL USING (client_id = auth.uid() OR is_staff_user());

CREATE POLICY "owner or staff" ON public.hormone_panels
  FOR ALL USING (client_id = auth.uid() OR is_staff_user());

CREATE POLICY "owner or staff" ON public.check_ins
  FOR ALL USING (client_id = auth.uid() OR is_staff_user());

CREATE POLICY "owner or staff" ON public.client_activity
  FOR ALL USING (client_id = auth.uid() OR is_staff_user());

-- ── Marker tables join via parent panel ─────────────
CREATE POLICY "owner or staff" ON public.blood_markers
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.blood_panels bp
      WHERE bp.id = blood_markers.panel_id
        AND (bp.client_id = auth.uid() OR is_staff_user())
    )
  );

CREATE POLICY "owner or staff" ON public.hormone_markers
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.hormone_panels hp
      WHERE hp.id = hormone_markers.panel_id
        AND (hp.client_id = auth.uid() OR is_staff_user())
    )
  );
