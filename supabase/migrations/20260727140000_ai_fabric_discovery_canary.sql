-- ============================================================================
-- AI Fabric — Phase 4: model auto-discovery + canary gate
--
-- ai_models has been canary-gated since Phase 1 (the router only considers
-- enabled AND canary_passed rows) but nothing populated it automatically —
-- every model required a manual INSERT (see docs/AI_FABRIC.md Phase 1 setup).
-- This adds the two functions that make the catalog self-maintaining without
-- weakening the gate: ai-discover finds candidate models, ai-canary decides
-- whether they're actually trustworthy enough to route to. A model is never
-- routable on discovery alone — only after it passes.
-- ============================================================================

ALTER TABLE public.ai_models
  ADD COLUMN canary_ran_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN canary_result JSONB,
  ADD COLUMN canary_attempts INT NOT NULL DEFAULT 0,
  -- 'manual' = seeded by a human (the Phase 1 setup path); 'auto' = found by
  -- ai-discover. Kept for audit — knowing how a routable model got here matters
  -- when something behaves unexpectedly.
  ADD COLUMN discovery_source TEXT NOT NULL DEFAULT 'manual';

-- ai-discover needs to insert new rows; Phase 2 only granted SELECT + UPDATE.
GRANT INSERT ON public.ai_models TO service_role;

COMMENT ON COLUMN public.ai_models.canary_passed IS
  'Routable gate. Set true only by ai-canary after every check in the suite passes. Never set true by discovery.';
COMMENT ON COLUMN public.ai_models.discovery_source IS
  'manual = seeded by a human; auto = found by ai-discover. Audit trail for how a routable model entered the catalog.';
