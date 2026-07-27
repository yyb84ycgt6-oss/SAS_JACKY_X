/**
 * jackie-route — provider-agnostic model router.
 *
 * Replaces the single-gateway assumption in jackie-chat. One OpenAI-compatible
 * entry point; underneath, an ordered ladder of (provider, model, key) triples
 * with per-error-class remedies.
 *
 * The central design point: failures are NOT interchangeable. A retry loop that
 * treats every error the same burns the whole credential pool on one bad
 * prompt. Each class gets the remedy that actually fits it — see REMEDIES.
 *
 * Streaming caveat, stated plainly: failover can only happen before response
 * bytes reach the client. Once an upstream returns 200 and we begin piping the
 * body, a mid-stream failure surfaces to the caller — there is no way to
 * un-send bytes. All connection and status errors are handled before that
 * point, which covers every failure class below.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, jsonResponse, preflight } from "../_shared/cors.ts";
import { decryptSecret } from "../_shared/crypto.ts";

const ATTEMPT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const HARD_MAX_ATTEMPTS = 8; // budget ceiling; a runaway ladder is a cost bug

type Outcome =
  | "ok" | "auth" | "quota" | "rate"
  | "timeout" | "server" | "content" | "badreq";

/** What each failure class means and what to do about it. */
const REMEDIES: Record<Exclude<Outcome, "ok">, {
  advance: boolean;      // try the next candidate?
  keyStatus?: string;    // mark the credential
  keyCooldownMs?: number;
  providerCooldownMs?: number;
  reason: string;
}> = {
  // Bad credential. Retrying it anywhere is pointless; it is dead until re-entered.
  auth:    { advance: true, keyStatus: "dead", reason: "credential rejected" },
  // Out of allowance. Park the key, move on — a sibling key may still have room.
  quota:   { advance: true, keyStatus: "quota_exhausted", keyCooldownMs: 3_600_000, reason: "quota exhausted" },
  // Too fast, not broken. Cool this key, try a sibling or another provider.
  rate:    { advance: true, keyStatus: "rate_limited", keyCooldownMs: 60_000, reason: "rate limited" },
  // Upstream trouble, not credential trouble. Break the provider, keep the key.
  timeout: { advance: true, providerCooldownMs: 120_000, reason: "upstream timeout" },
  server:  { advance: true, providerCooldownMs: 120_000, reason: "upstream error" },
  // The prompt was refused. Every provider will refuse it the same way, so
  // rotating credentials just burns the pool. Fail loudly instead.
  content: { advance: false, reason: "content filtered — identical result upstream, not retried" },
  // Our request was malformed. Rotating hides the bug.
  badreq:  { advance: false, reason: "malformed request — not retried" },
};

function classify(status: number, body: string): Outcome {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate";
  if (status >= 500) return "server";
  if (status === 400) {
    return /content|safety|filter|blocked|policy|moderation/i.test(body)
      ? "content"
      : "badreq";
  }
  if (status === 404 || status === 422) return "badreq";
  return "server";
}

/** Spread stored cooldowns so sibling keys don't all wake at the same instant. */
function jitter(ms: number): number {
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

type Candidate = {
  providerSlug: string;
  providerId: string;
  baseUrl: string;
  authScheme: string;
  modelId: string;
  keyId: string | null;
  ciphertext: string | null;
  iv: string | null;
  score: number;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return jsonResponse({ error: "Unauthorized" }, 401);

  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse({ error: "messages[] required" }, 400);
    }

    const wantStream = body.stream !== false;
    const kind: string | undefined = body.kind;
    const modelOverride: string | undefined = body.model;
    const maxAttempts = Math.min(
      Math.max(Number(body.max_attempts) || DEFAULT_MAX_ATTEMPTS, 1),
      HARD_MAX_ATTEMPTS,
    );

    const nowIso = new Date().toISOString();

    // ── Build the candidate ladder ──────────────────────────────────────────
    const { data: providers, error: provErr } = await admin
      .from("ai_providers")
      .select("id, slug, base_url, auth_scheme, openai_compatible, priority, cooldown_until, enabled")
      .eq("enabled", true)
      .order("priority", { ascending: true });
    if (provErr) throw provErr;

    const liveProviders = (providers ?? []).filter(
      (p) => !p.cooldown_until || p.cooldown_until < nowIso,
    );
    if (liveProviders.length === 0) {
      return jsonResponse({ error: "All providers are in cooldown", retry_after: 120 }, 503);
    }

    const providerIds = liveProviders.map((p) => p.id);

    const { data: keys, error: keyErr } = await admin
      .from("ai_provider_keys")
      .select("id, provider_id, ciphertext, iv, cooldown_until, status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .in("provider_id", providerIds);
    if (keyErr) throw keyErr;

    const usableKeys = (keys ?? []).filter(
      (k) => !k.cooldown_until || k.cooldown_until < nowIso,
    );

    let modelQuery = admin
      .from("ai_models")
      .select("provider_id, model_id, kinds, health_score")
      .eq("enabled", true)
      .eq("canary_passed", true)   // unverified models are never routable
      .in("provider_id", providerIds)
      .order("health_score", { ascending: false });
    if (modelOverride) modelQuery = modelQuery.eq("model_id", modelOverride);

    const { data: models, error: modelErr } = await modelQuery;
    if (modelErr) throw modelErr;

    const eligibleModels = (models ?? []).filter(
      (m) => !kind || modelOverride || (m.kinds ?? []).includes(kind),
    );

    const providerById = new Map(liveProviders.map((p) => [p.id, p]));
    const keysByProvider = new Map<string, typeof usableKeys>();
    for (const k of usableKeys) {
      const list = keysByProvider.get(k.provider_id) ?? [];
      list.push(k);
      keysByProvider.set(k.provider_id, list);
    }

    const candidates: Candidate[] = [];
    for (const m of eligibleModels) {
      const p = providerById.get(m.provider_id);
      if (!p) continue;
      if (!p.openai_compatible) continue; // shim point for non-OpenAI schemas

      const provKeys = keysByProvider.get(m.provider_id) ?? [];

      if (p.auth_scheme === "none") {
        // Keyless upstream (local Ollama). No credential to rotate.
        candidates.push({
          providerSlug: p.slug, providerId: p.id, baseUrl: p.base_url,
          authScheme: p.auth_scheme, modelId: m.model_id,
          keyId: null, ciphertext: null, iv: null, score: Number(m.health_score),
        });
        continue;
      }

      for (const k of provKeys) {
        candidates.push({
          providerSlug: p.slug, providerId: p.id, baseUrl: p.base_url,
          authScheme: p.auth_scheme, modelId: m.model_id,
          keyId: k.id, ciphertext: k.ciphertext, iv: k.iv, score: Number(m.health_score),
        });
      }
    }

    if (candidates.length === 0) {
      return jsonResponse({
        error: "No routable candidates",
        hint:
          "Add a provider key via ai-vault/add, and ensure at least one model is " +
          "enabled with canary_passed = true. Auto-discovered models stay " +
          "unroutable until they pass the canary suite.",
      }, 503);
    }

    // Best health first; providers already ordered by priority as the tiebreak.
    candidates.sort((a, b) => b.score - a.score);

    // ── Walk the ladder ─────────────────────────────────────────────────────
    const trail: { provider: string; model: string; outcome: Outcome; status?: number; ms: number }[] = [];

    for (let attempt = 0; attempt < Math.min(maxAttempts, candidates.length); attempt++) {
      const c = candidates[attempt];
      const started = Date.now();

      let outcome: Outcome = "server";
      let httpStatus = 0;
      let errText = "";
      let upstream: Response | null = null;

      try {
        let secret: string | null = null;
        if (c.ciphertext && c.iv) {
          secret = await decryptSecret(c.ciphertext, c.iv);
        }

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (c.authScheme === "bearer" && secret) headers["Authorization"] = `Bearer ${secret}`;
        else if (c.authScheme === "x-api-key" && secret) headers["x-api-key"] = secret;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

        try {
          upstream = await fetch(`${c.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: c.modelId,
              messages,
              stream: wantStream,
              ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
            }),
            signal: controller.signal,
          });
          httpStatus = upstream.status;

          if (upstream.ok) {
            outcome = "ok";
          } else {
            errText = (await upstream.text()).slice(0, 500);
            outcome = classify(httpStatus, errText);
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcome = /abort/i.test(msg) ? "timeout" : "server";
        errText = msg.slice(0, 500);
      }

      const latency = Date.now() - started;
      trail.push({
        provider: c.providerSlug, model: c.modelId,
        outcome, status: httpStatus || undefined, ms: latency,
      });

      // Telemetry first — it must survive whatever happens next.
      await admin.from("ai_route_events").insert({
        user_id: user.id,
        provider_slug: c.providerSlug,
        model_id: c.modelId,
        key_id: c.keyId,
        attempt: attempt + 1,
        outcome,
        http_status: httpStatus || null,
        latency_ms: latency,
        error: outcome === "ok" ? null : errText,
      });

      if (outcome === "ok" && upstream) {
        if (c.keyId) {
          await admin.rpc("record_key_outcome", { p_key_id: c.keyId, p_success: true });
        }

        const passthrough = new Headers(corsHeaders);
        passthrough.set(
          "Content-Type",
          upstream.headers.get("Content-Type") ??
            (wantStream ? "text/event-stream" : "application/json"),
        );
        // Surfaced so callers can see which upstream actually served them.
        passthrough.set("X-Jackie-Provider", c.providerSlug);
        passthrough.set("X-Jackie-Model", c.modelId);
        passthrough.set("X-Jackie-Attempt", String(attempt + 1));

        return new Response(upstream.body, { status: 200, headers: passthrough });
      }

      // ── Apply the remedy for this failure class ───────────────────────────
      const remedy = REMEDIES[outcome as Exclude<Outcome, "ok">];

      if (c.keyId) {
        await admin.rpc("record_key_outcome", { p_key_id: c.keyId, p_success: false });
      }

      if (c.keyId && (remedy.keyStatus || remedy.keyCooldownMs)) {
        await admin.from("ai_provider_keys").update({
          ...(remedy.keyStatus ? { status: remedy.keyStatus } : {}),
          ...(remedy.keyCooldownMs
            ? { cooldown_until: new Date(Date.now() + jitter(remedy.keyCooldownMs)).toISOString() }
            : {}),
          last_error: `${outcome}: ${errText}`.slice(0, 500),
        }).eq("id", c.keyId);
      }

      if (remedy.providerCooldownMs) {
        await admin.from("ai_providers").update({
          cooldown_until: new Date(Date.now() + jitter(remedy.providerCooldownMs)).toISOString(),
        }).eq("id", c.providerId);
      }

      if (!remedy.advance) {
        // Non-retryable by design. Returning the real reason beats silently
        // exhausting the pool against an error no provider will answer.
        return jsonResponse({
          error: remedy.reason,
          outcome,
          provider: c.providerSlug,
          model: c.modelId,
          detail: errText,
          trail,
        }, outcome === "content" ? 422 : 400);
      }
    }

    await admin.from("ai_route_events").insert({
      user_id: user.id,
      outcome: "exhausted",
      attempt: trail.length,
      error: `ladder exhausted after ${trail.length} attempts`,
    });

    return jsonResponse({
      error: "All routing candidates failed",
      attempts: trail.length,
      trail,
      hint: "Check key health via ai-vault/list — credentials may be cooling down or dead.",
    }, 502);
  } catch (e) {
    console.error("jackie-route error:", e);
    return jsonResponse({ error: "Router failure" }, 500);
  }
});
