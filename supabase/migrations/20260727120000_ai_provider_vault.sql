-- ============================================================================
-- AI Provider Vault + Router Fabric  (Phase 1)
--
-- Replaces the single-gateway / single-key assumption in jackie-chat with a
-- real multi-provider substrate:
--
--   ai_providers      global catalog of upstreams (read-only to clients)
--   ai_models         model catalog, auto-discoverable, canary-gated
--   ai_provider_keys  per-user credentials, ENCRYPTED, never client-readable
--   ai_route_events   per-attempt telemetry that drives health scoring
--
-- Security posture: provider keys are AES-GCM encrypted by the edge function
-- before insert. The ciphertext column is unreachable from the client by
-- construction (see the grants below) — clients read a view that omits it.
-- ============================================================================

-- ── Providers ───────────────────────────────────────────────────────────────
CREATE TABLE public.ai_providers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  -- how the credential is presented: bearer | x-api-key | query | none
  auth_scheme TEXT NOT NULL DEFAULT 'bearer',
  -- true when the upstream speaks the OpenAI /chat/completions schema
  openai_compatible BOOLEAN NOT NULL DEFAULT true,
  free_tier BOOLEAN NOT NULL DEFAULT true,
  -- relative path for model auto-discovery, e.g. '/models'
  models_path TEXT DEFAULT '/models',
  -- lower runs first when health scores tie
  priority INT NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- provider-wide circuit breaker (outage, not per-key rate limiting)
  cooldown_until TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;

-- Catalog is global and readable; only the service role may write it.
CREATE POLICY "Authenticated read providers" ON public.ai_providers
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Deny client provider writes" ON public.ai_providers
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TRIGGER trg_ai_providers_updated_at
  BEFORE UPDATE ON public.ai_providers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Models ──────────────────────────────────────────────────────────────────
CREATE TABLE public.ai_models (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES public.ai_providers(id) ON DELETE CASCADE,
  -- the exact string sent upstream
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  -- routing hints: reasoning | coding | fast | long-context
  kinds TEXT[] NOT NULL DEFAULT '{}',
  context_window INT,
  supports_tools BOOLEAN NOT NULL DEFAULT false,
  free BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- Promotion gate: an auto-discovered model is NOT routable until it has
  -- passed the canary suite. Discovery without verification is how a silent
  -- upstream model swap reaches production.
  canary_passed BOOLEAN NOT NULL DEFAULT false,
  -- rolling success rate in [0,1], maintained from ai_route_events
  health_score NUMERIC(5, 4) NOT NULL DEFAULT 1.0,
  discovered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);

CREATE INDEX idx_ai_models_routable
  ON public.ai_models (provider_id, health_score DESC)
  WHERE enabled AND canary_passed;

ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read models" ON public.ai_models
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Deny client model writes" ON public.ai_models
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TRIGGER trg_ai_models_updated_at
  BEFORE UPDATE ON public.ai_models
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Provider keys (encrypted) ───────────────────────────────────────────────
CREATE TABLE public.ai_provider_keys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider_id UUID NOT NULL REFERENCES public.ai_providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  -- AES-GCM ciphertext + iv, both base64. Written only by the edge function.
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  -- last 4 chars of the raw key, for UI disambiguation only
  key_hint TEXT NOT NULL,
  -- active | rate_limited | quota_exhausted | dead | disabled
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  -- per-key circuit breaker; set on 429/402, cleared when it elapses
  cooldown_until TIMESTAMP WITH TIME ZONE,
  success_count BIGINT NOT NULL DEFAULT 0,
  failure_count BIGINT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_provider_keys_lookup
  ON public.ai_provider_keys (user_id, provider_id, status);

ALTER TABLE public.ai_provider_keys ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for authenticated: the base table (which holds ciphertext)
-- is unreachable from the client. Reads go through ai_provider_keys_safe.
CREATE POLICY "Users insert own provider keys" ON public.ai_provider_keys
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own provider keys" ON public.ai_provider_keys
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own provider keys" ON public.ai_provider_keys
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER trg_ai_provider_keys_updated_at
  BEFORE UPDATE ON public.ai_provider_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Belt and braces: even if a future policy is added by mistake, the column
-- grants keep ciphertext/iv out of client reach.
REVOKE ALL ON public.ai_provider_keys FROM anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ai_provider_keys TO authenticated;

-- Safe projection. Runs as owner (security_invoker defaults to off) so it can
-- read past the base table's RLS, and filters to the caller itself.
CREATE VIEW public.ai_provider_keys_safe
WITH (security_barrier = true) AS
SELECT
  id, user_id, provider_id, label, key_hint, status, last_error,
  cooldown_until, success_count, failure_count, last_used_at, created_at
FROM public.ai_provider_keys
WHERE user_id = auth.uid();

GRANT SELECT ON public.ai_provider_keys_safe TO authenticated;

COMMENT ON VIEW public.ai_provider_keys_safe IS
  'Client-facing projection of ai_provider_keys. Deliberately omits ciphertext and iv. Never add them here.';

-- ── Route telemetry ─────────────────────────────────────────────────────────
CREATE TABLE public.ai_route_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider_slug TEXT,
  model_id TEXT,
  key_id UUID,
  attempt INT NOT NULL DEFAULT 1,
  -- ok | auth | quota | rate | timeout | server | content | badreq | exhausted
  outcome TEXT NOT NULL,
  http_status INT,
  latency_ms INT,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_route_events_user_ts
  ON public.ai_route_events (user_id, created_at DESC);
CREATE INDEX idx_ai_route_events_scoring
  ON public.ai_route_events (provider_slug, model_id, created_at DESC);

ALTER TABLE public.ai_route_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own route events" ON public.ai_route_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- Inserts come from the edge function (service role) only; telemetry a client
-- can forge is telemetry that can be used to steer routing.
CREATE POLICY "Deny client route event writes" ON public.ai_route_events
  FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "Deny route event mutation" ON public.ai_route_events
  FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);

-- ── Health scoring ──────────────────────────────────────────────────────────
-- Rolling success rate over the last 200 attempts per (provider, model).
-- Called by the probe function; cheap enough to run on a schedule.
CREATE OR REPLACE FUNCTION public.recompute_ai_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH recent AS (
    SELECT provider_slug, model_id, outcome,
           ROW_NUMBER() OVER (
             PARTITION BY provider_slug, model_id ORDER BY created_at DESC
           ) AS rn
    FROM public.ai_route_events
    WHERE created_at > now() - interval '7 days'
  ),
  scored AS (
    SELECT provider_slug, model_id,
           COUNT(*) FILTER (WHERE outcome = 'ok')::numeric
             / GREATEST(COUNT(*), 1)::numeric AS score
    FROM recent
    WHERE rn <= 200
    GROUP BY provider_slug, model_id
  )
  UPDATE public.ai_models m
  SET health_score = LEAST(GREATEST(s.score, 0), 1)
  FROM scored s, public.ai_providers p
  WHERE m.provider_id = p.id
    AND p.slug = s.provider_slug
    AND m.model_id = s.model_id;
END;
$$;

-- NOTE: Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- revoking from named roles alone does NOT remove that grant. PUBLIC must be
-- revoked explicitly or any authenticated client can call this.
REVOKE ALL ON FUNCTION public.recompute_ai_health() FROM PUBLIC, anon, authenticated;

-- Atomic per-key counters. Called by the router on every attempt so concurrent
-- requests cannot lose increments to a read-modify-write race.
CREATE OR REPLACE FUNCTION public.record_key_outcome(p_key_id UUID, p_success BOOLEAN)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ai_provider_keys
  SET success_count = success_count + CASE WHEN p_success THEN 1 ELSE 0 END,
      failure_count = failure_count + CASE WHEN p_success THEN 0 ELSE 1 END,
      last_used_at  = now(),
      last_error    = CASE WHEN p_success THEN NULL ELSE last_error END
  WHERE id = p_key_id;
$$;

-- Critical: this is SECURITY DEFINER and updates a key by id with no ownership
-- check, so an authenticated caller reaching it could tamper with another
-- user's credential counters. PUBLIC must be revoked, not just the named roles.
REVOKE ALL ON FUNCTION public.record_key_outcome(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ── Seed: free-tier providers ───────────────────────────────────────────────
-- Credentials are NOT seeded. Each row is an empty socket until the owner adds
-- a key they legitimately hold via the ai-vault function.
INSERT INTO public.ai_providers
  (slug, label, base_url, auth_scheme, openai_compatible, free_tier, priority, notes)
VALUES
  ('groq',        'Groq',              'https://api.groq.com/openai/v1',                    'bearer', true, true, 10, 'Very fast free tier; strict RPM limits.'),
  ('cerebras',    'Cerebras',          'https://api.cerebras.ai/v1',                        'bearer', true, true, 20, 'High throughput free tier.'),
  ('google-ais',  'Google AI Studio',  'https://generativelanguage.googleapis.com/v1beta/openai', 'bearer', true, true, 30, 'Gemini via OpenAI-compatible endpoint.'),
  ('openrouter',  'OpenRouter',        'https://openrouter.ai/api/v1',                      'bearer', true, true, 40, 'Aggregator; many :free models.'),
  ('mistral',     'Mistral',           'https://api.mistral.ai/v1',                         'bearer', true, true, 50, 'Free experiment tier.'),
  ('together',    'Together AI',       'https://api.together.xyz/v1',                       'bearer', true, true, 60, 'Free tier on selected models.'),
  ('huggingface', 'HuggingFace Router','https://router.huggingface.co/v1',                  'bearer', true, true, 70, 'Serverless inference router.'),
  ('lovable',     'Lovable Gateway',   'https://ai.gateway.lovable.dev/v1',                 'bearer', true, false, 80, 'Existing gateway used by jackie-chat.'),
  ('ollama',      'Ollama (local)',    'http://localhost:11434/v1',                         'none',   true, true, 90, 'Local inference. Unmetered; no credential required.');
