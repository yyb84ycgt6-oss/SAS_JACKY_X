-- ============================================================================
-- AI Fabric — Phase 2: probe scheduling, health recompute cadence, kill switch
--
-- Phase 1 shipped cooldowns that self-clear on the next request (a key past
-- its cooldown_until is simply usable again). What Phase 1 did NOT have:
--   1. A way to know a key is healthy again WITHOUT waiting for a live user
--      request to hit it and possibly fail again.
--   2. health_score staying current when real traffic is light — it is only
--      as fresh as the last recompute_ai_health() call, and Phase 1 never
--      scheduled one.
--   3. Any global kill switch. A single flag to halt all routing, independent
--      of any per-key or per-provider state.
--   4. A soft per-user budget, so one runaway loop cannot burn an entire
--      credential pool in a burst before a human notices.
--
-- pg_cron / pg_net are enabled defensively: hosted Supabase has them
-- available, a bare Postgres install (e.g. local dev) does not. Missing
-- extensions degrade to a documented manual/external-scheduler path rather
-- than failing the whole migration — see docs/AI_FABRIC.md.
-- ============================================================================

-- ── Kill switch + budget ─────────────────────────────────────────────────────
-- Singleton table: exactly one row, enforced by the id=1 check rather than a
-- separate lookup table, so "the settings row" is unambiguous by construction.
CREATE TABLE public.ai_fabric_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  routing_enabled BOOLEAN NOT NULL DEFAULT true,
  -- Soft cap: a request over this limit gets a clear 429, not a silent drop.
  -- Deliberately per-user, not global — one runaway caller should not be able
  -- to starve every other user of the same pool.
  max_route_events_per_user_per_hour INT NOT NULL DEFAULT 200,
  disabled_reason TEXT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

INSERT INTO public.ai_fabric_settings (id) VALUES (1);

ALTER TABLE public.ai_fabric_settings ENABLE ROW LEVEL SECURITY;

-- Readable so the UI can show "routing paused" honestly; only service role writes.
CREATE POLICY "Authenticated read fabric settings" ON public.ai_fabric_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Deny client fabric settings writes" ON public.ai_fabric_settings
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TRIGGER trg_ai_fabric_settings_updated_at
  BEFORE UPDATE ON public.ai_fabric_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Probe bookkeeping ────────────────────────────────────────────────────────
-- Distinguishes "never probed" from "probed and currently healthy" so the
-- prober can prioritize keys it hasn't looked at yet or hasn't looked at in a
-- while, instead of re-checking the same handful of already-healthy keys.
ALTER TABLE public.ai_provider_keys
  ADD COLUMN last_probed_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX idx_ai_provider_keys_probe_priority
  ON public.ai_provider_keys (last_probed_at ASC NULLS FIRST)
  WHERE status != 'disabled';

-- ── Extensions (best-effort) ─────────────────────────────────────────────────
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
  RAISE NOTICE 'pg_cron unavailable in this environment — scheduling recompute_ai_health() falls back to an external scheduler. See docs/AI_FABRIC.md.';
END $$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
  RAISE NOTICE 'pg_net unavailable in this environment — the ai-probe edge function must be invoked by an external scheduler instead of pg_cron+pg_net. See docs/AI_FABRIC.md.';
END $$;

-- Schedule health recompute every 15 minutes. This is pure SQL (no network
-- call needed) so it only depends on pg_cron, not pg_net.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Idempotent: drop any prior job of this name before scheduling, so a
    -- re-run (retry, or manual re-apply) cannot leave duplicate jobs behind.
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ai-fabric-recompute-health';
    PERFORM cron.schedule(
      'ai-fabric-recompute-health',
      '*/15 * * * *',
      $cron$ SELECT public.recompute_ai_health(); $cron$
    );
  END IF;
END $$;

-- ── Corrective grants, found by testing against a real database ────────────
-- A CREATE POLICY without a matching table-level GRANT is inert in plain
-- Postgres — RLS narrows an existing privilege, it does not create one. Phase 1
-- relied on Supabase's inherited default privileges to fill that gap for
-- authenticated/service_role, which is environment state a migration file
-- cannot verify offline. Applying both migrations against a real Postgres 16
-- instance surfaced two concrete breaks from that assumption:
--
--   1. `authenticated` could not SELECT ai_providers/ai_models at all — the
--      catalog reads in src/lib/jackie-providers.ts (listProviders) would
--      have failed outright.
--   2. `service_role` could not write ai_provider_keys — every edge function
--      (ai-vault, jackie-route, ai-probe) needs this and would have failed on
--      first use.
--
-- Fixed by granting explicitly, so routing does not depend on how a given
-- project happened to bootstrap its default privileges.

GRANT SELECT ON public.ai_providers TO authenticated;
GRANT SELECT ON public.ai_models TO authenticated;
GRANT SELECT ON public.ai_fabric_settings TO authenticated;

GRANT SELECT, UPDATE ON public.ai_providers TO service_role;
GRANT SELECT, UPDATE ON public.ai_models TO service_role;
GRANT SELECT, UPDATE ON public.ai_provider_keys TO service_role;
GRANT SELECT, INSERT ON public.ai_route_events TO service_role;
GRANT SELECT ON public.ai_fabric_settings TO service_role;

GRANT EXECUTE ON FUNCTION public.recompute_ai_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.record_key_outcome(UUID, BOOLEAN) TO service_role;

COMMENT ON TABLE public.ai_fabric_settings IS
  'Singleton control row. routing_enabled=false is the kill switch — jackie-route checks it before touching any candidate.';
