/**
 * ai-canary — the promotion gate for discovered models.
 *
 * A model found by ai-discover is inert (canary_passed=false, unroutable)
 * until it passes every check in CANARY_SUITE against a real call to the
 * provider. This is deliberately simple, cheap, and deterministic-ish: it is
 * not evaluating model quality, only "does this respond like a working chat
 * model at all" — coherent, follows a trivial instruction, gets basic
 * arithmetic right. That's enough to catch the failure modes that matter here:
 * a model ID that 404s, one that only does embeddings despite the name, or an
 * upstream that silently swapped what a model ID points to.
 *
 * Service-role only, same reasoning as ai-discover and ai-probe.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { jsonResponse, preflight } from "../_shared/cors.ts";
import { decryptSecret } from "../_shared/crypto.ts";

const MAX_MODELS_PER_RUN = 10;
const CALL_TIMEOUT_MS = 20_000;
// A model gets this many independent canary runs (each running the full
// suite) before it is given up on and disabled — a flaky model that fails
// intermittently should not retry forever burning quota on every ai-canary
// invocation.
const MAX_ATTEMPTS_BEFORE_DISABLE = 3;

type CanaryCheck = { label: string; prompt: string; check: (text: string) => boolean };

const CANARY_SUITE: CanaryCheck[] = [
  {
    label: "instruction-following",
    prompt: "Reply with exactly one word: PONG",
    check: (t) => /\bpong\b/i.test(t),
  },
  {
    label: "basic-arithmetic",
    prompt: "What is 12 + 7? Reply with only the number, nothing else.",
    check: (t) => /\b19\b/.test(t),
  },
  {
    label: "coherent-completion",
    prompt: "Complete this sentence with a single word: The opposite of hot is ___.",
    check: (t) => {
      const trimmed = t.trim();
      return trimmed.length > 0 && trimmed.length < 80 && /cold/i.test(trimmed);
    },
  },
];

function requireServiceRole(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!serviceKey && token === serviceKey;
}

async function callModel(opts: {
  baseUrl: string; authScheme: string; secret: string | null; modelId: string; prompt: string;
}): Promise<{ ok: boolean; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.authScheme === "bearer" && opts.secret) headers["Authorization"] = `Bearer ${opts.secret}`;
    else if (opts.authScheme === "x-api-key" && opts.secret) headers["x-api-key"] = opts.secret;

    const resp = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.modelId,
        messages: [{ role: "user", content: opts.prompt }],
        stream: false,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, text: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (!requireServiceRole(req)) return jsonResponse({ error: "Requires service role" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const { data: candidates, error } = await admin
      .from("ai_models")
      .select(
        "id, provider_id, model_id, canary_attempts, ai_providers(slug, base_url, auth_scheme, enabled)",
      )
      .eq("canary_passed", false)
      .eq("enabled", true)
      .lt("canary_attempts", MAX_ATTEMPTS_BEFORE_DISABLE)
      .order("discovered_at", { ascending: true })
      .limit(MAX_MODELS_PER_RUN);
    if (error) throw error;

    const outcomes: { model: string; provider: string; passed: boolean; checks: unknown }[] = [];

    for (const m of candidates ?? []) {
      const provider = m.ai_providers as unknown as {
        slug: string; base_url: string; auth_scheme: string; enabled: boolean;
      } | null;
      if (!provider?.enabled) continue;

      let secret: string | null = null;
      if (provider.auth_scheme !== "none") {
        const { data: key } = await admin
          .from("ai_provider_keys")
          .select("ciphertext, iv")
          .eq("provider_id", m.provider_id)
          .eq("status", "active")
          .limit(1)
          .maybeSingle();
        if (!key) {
          outcomes.push({ model: m.model_id, provider: provider.slug, passed: false, checks: "no active key" });
          continue;
        }
        try {
          secret = await decryptSecret(key.ciphertext, key.iv);
        } catch {
          outcomes.push({ model: m.model_id, provider: provider.slug, passed: false, checks: "decrypt failed" });
          continue;
        }
      }

      const checkResults: { label: string; passed: boolean; response: string }[] = [];
      for (const c of CANARY_SUITE) {
        const result = await callModel({
          baseUrl: provider.base_url, authScheme: provider.auth_scheme, secret,
          modelId: m.model_id, prompt: c.prompt,
        });
        checkResults.push({
          label: c.label,
          passed: result.ok && c.check(result.text),
          response: result.text.slice(0, 200),
        });
      }

      const allPassed = checkResults.every((r) => r.passed);
      const nextAttempts = m.canary_attempts + 1;

      await admin.from("ai_models").update({
        canary_passed: allPassed,
        canary_ran_at: new Date().toISOString(),
        canary_result: checkResults,
        canary_attempts: nextAttempts,
        // Give up after MAX_ATTEMPTS_BEFORE_DISABLE rather than retrying a
        // consistently-failing model forever on every scheduled run.
        enabled: allPassed || nextAttempts < MAX_ATTEMPTS_BEFORE_DISABLE,
      }).eq("id", m.id);

      outcomes.push({ model: m.model_id, provider: provider.slug, passed: allPassed, checks: checkResults });
    }

    return jsonResponse({
      evaluated: outcomes.length,
      promoted: outcomes.filter((o) => o.passed).length,
      outcomes,
    });
  } catch (e) {
    console.error("ai-canary error:", e);
    return jsonResponse({ error: "Canary sweep failed" }, 500);
  }
});
