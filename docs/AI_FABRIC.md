# AI Provider Fabric — Setup

Phase 1 of the multi-provider router: vault, registry, and failover ladder.

## What this replaces

`jackie-chat` sends every request to one gateway (`ai.gateway.lovable.dev`) with
one credential (`LOVABLE_API_KEY`) and a six-model allowlist. `jackie-route`
replaces that with an ordered ladder across every provider and credential you
hold, with a distinct remedy per failure class.

`orchestrate()` in `src/lib/jackie-orchestrator.ts` now calls `jackie-route`
first and **falls back to the legacy path** when the vault has no routable
candidates — so shipping this does not take the app down before setup is done.

## Setup

### 1. Generate the vault key

Provider credentials are AES-256-GCM encrypted before they touch the database.

```bash
openssl rand -base64 32
supabase secrets set AI_VAULT_KEY="<output>"
```

**Rotating `AI_VAULT_KEY` invalidates every stored credential.** There is no
recovery path by design — a vault key recoverable from inside the system is not
protecting anything. Rotate only when you can re-enter every key.

### 2. Apply the migration

```bash
supabase db push
```

Creates `ai_providers` (9 free-tier upstreams seeded), `ai_models`,
`ai_provider_keys`, `ai_route_events`, plus health-scoring functions.

### 3. Deploy the functions

```bash
supabase functions deploy ai-vault
supabase functions deploy jackie-route
```

### 4. Add credentials

Keys you legitimately hold, one account per provider. Via the client:

```ts
import { addKey } from "@/lib/jackie-providers";
await addKey("groq", "primary", "gsk_...");
```

The raw key is unrecoverable after this call. There is no reveal endpoint.

### 5. Seed models — required, nothing routes without it

`ai_models` ships **empty**, and the router only considers rows where
`enabled AND canary_passed`. This is deliberate: auto-discovery without
verification means a silent upstream model swap reaches production unnoticed.

Until Phase 4 automates discovery + canary promotion, seed manually:

```sql
INSERT INTO public.ai_models (provider_id, model_id, label, kinds, context_window, free, canary_passed)
SELECT id, 'llama-3.3-70b-versatile', 'Llama 3.3 70B',
       ARRAY['fast','coding'], 128000, true, true
FROM public.ai_providers WHERE slug = 'groq';
```

Set `canary_passed = true` only for models you have actually exercised.

## Failure handling

Each class gets the remedy that fits it, not a blanket retry:

| Upstream | Class | Remedy |
|---|---|---|
| 401 / 403 | `auth` | Key marked `dead`. Not retried anywhere — it is bad everywhere |
| 402 | `quota` | Key parked 1h, ladder advances |
| 429 | `rate` | Key cooled 60s (jittered), ladder advances |
| timeout | `timeout` | Provider circuit-broken 2min, key untouched |
| 5xx | `server` | Provider circuit-broken 2min |
| 400 + content signal | `content` | **Not retried.** Every provider refuses it identically; rotating only burns the pool |
| other 4xx | `badreq` | **Not retried.** Rotating hides our own bug |

Cooldowns carry ±15% jitter so sibling keys don't all wake together.

Budget ceiling: 4 attempts per request by default, 8 hard maximum.

### Streaming caveat

Failover happens only *before* response bytes reach the client. Once an upstream
returns 200 and the body begins piping, a mid-stream failure surfaces to the
caller — bytes cannot be un-sent. Every failure class above is detected before
that point.

## Security model

- Credentials are encrypted in the edge function, never in the browser.
- `ai_provider_keys` has **no SELECT policy** for `authenticated`, and table
  grants are revoked. The ciphertext column is unreachable from a client.
- Clients read `ai_provider_keys_safe`, a view that omits `ciphertext` and `iv`
  and filters to `auth.uid()`. Never add those columns to it.
- `ai_route_events` inserts are service-role only. Telemetry a client can forge
  is telemetry that can steer routing.
- `recompute_ai_health()` and `record_key_outcome()` revoke `PUBLIC`, not just
  named roles — Postgres grants EXECUTE to PUBLIC by default, and revoking from
  `anon`/`authenticated` alone leaves them callable.

Verified against a live Postgres 16: client role denied on the base table,
denied on both privileged functions, cross-user isolation holds through the view.

## Not built, deliberately

Automated provider signup or key farming to evade free-tier limits. It breaks
provider terms and is self-defeating — detection costs the entire pool at once,
the opposite of resilience. The fabric maximizes what legitimately-held free
tiers give you, which across nine providers plus local Ollama is substantial.

## Phase 2 — probes, health cadence, kill switch, budget

Added on top of Phase 1 without touching its schema or router contract.

### Scheduled health sweep

`ai-probe` sweeps up to 50 keys per invocation, oldest-`last_probed_at`-first,
concurrency-limited to 5. It finds recovered keys proactively instead of
waiting for a live user request to land on one after its cooldown expires, and
keeps `health_score` current even when real traffic is light.

Requires the **service role key**, not a user JWT — it reads every user's
credentials to sweep them, so it is not reachable from the client.

Scheduling, in order of preference:
1. **pg_cron + pg_net**, enabled automatically if available on your Supabase
   project (Database → Extensions). The migration schedules
   `recompute_ai_health()` every 15 minutes via pg_cron directly — no network
   hop needed for that part.
2. **External scheduler** otherwise — a GitHub Actions cron or Supabase's own
   scheduled triggers hitting the `ai-probe` function URL with the service role
   key. Both extensions are optional; nothing here requires them.

### Kill switch

```sql
UPDATE public.ai_fabric_settings SET routing_enabled = false, disabled_reason = 'reason here';
```

`jackie-route` checks this before touching any candidate, credential, or
upstream — a 503 the moment it's off. `ai-probe` keeps running underneath a
paused fabric, since the switch stops routing, not observation: health data
stays current for whenever you flip it back.

Readable by `authenticated` (so the UI can show "routing paused" honestly),
writable only by `service_role`.

### Per-user budget

Soft cap, `ai_fabric_settings.max_route_events_per_user_per_hour` (default
200). A caller over the cap gets a clear `429` with `retry_after`, not a
silent failure three layers deep. This is the backstop against a runaway loop
burning an entire credential pool in one burst before a human notices — check
happens before the ladder is even built.

### What testing against a real database caught this round

Applying both migrations to live Postgres 16 — not just reading them — surfaced
two real permission bugs neither the SQL author nor a syntax check would catch:

1. **`authenticated` could not read `ai_providers`/`ai_models`/`ai_fabric_settings`
   at all.** A `CREATE POLICY` without a matching table-level `GRANT` is inert in
   plain Postgres — RLS narrows an existing privilege, it does not create one.
   `listProviders()` in `src/lib/jackie-providers.ts` would have failed outright.
2. **`service_role` could not write `ai_provider_keys` or insert
   `ai_route_events`.** Every edge function needs this on first use. Phase 1's
   `REVOKE ALL ... FROM anon, authenticated` never granted `service_role`
   anything explicitly — it was inherited from Supabase's default privilege
   bootstrap, which is environment state a migration file cannot verify offline.

Both fixed with explicit `GRANT`s in the Phase 2 migration rather than
continuing to depend on an assumption about inherited environment
configuration. Re-verified with a 12-point pass covering both bugs, cross-user
isolation, and every privileged function/table.

One test-harness lesson worth keeping: the first re-test run produced *false*
failures on the service-role checks, because the local stub `service_role` role
lacked `BYPASSRLS` — the actual mechanism Supabase's `service_role` uses to
reach everything, not policy grants. Fixed the harness, not the migration; real
Supabase already has this. Recorded here so the next person testing this
locally doesn't chase a phantom bug.

## Next phases

3. PC desktop shell as `/pc`, on React 18
4. Auto-discovery with canary promotion
