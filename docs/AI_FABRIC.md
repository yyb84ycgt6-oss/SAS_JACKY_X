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

## Next phases

2. Scheduled probes + health scoring feeding candidate ordering
3. PC desktop shell as `/pc`, on React 18
4. Auto-discovery with canary promotion, budget caps, kill switch
