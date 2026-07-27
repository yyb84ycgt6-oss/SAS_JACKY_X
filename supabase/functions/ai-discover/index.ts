/**
 * ai-discover — finds candidate models from each provider's /models endpoint.
 *
 * Discovery alone confers NO routing eligibility. Every row this writes has
 * canary_passed=false; jackie-route already refuses anything but
 * enabled AND canary_passed. Auto-discovery without that gate is how a silent
 * upstream model swap reaches production — a provider renaming or replacing
 * a model would otherwise become routable the instant it appears, with no
 * verification that it behaves like a chat model at all.
 *
 * Service-role only, like ai-probe: the catalog is global, but calling a
 * provider's /models endpoint needs a real credential, and this reads across
 * users to find one.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { jsonResponse, preflight } from "../_shared/cors.ts";
import { decryptSecret } from "../_shared/crypto.ts";

const MAX_PROVIDERS_PER_RUN = 10;
const FETCH_TIMEOUT_MS = 15_000;

// Model IDs matching these are not chat-completion models — embeddings,
// speech, image, and moderation endpoints all show up in the same /models
// listing on several providers. Excluded before they ever reach the canary
// suite, which would otherwise waste budget failing them one by one.
const NON_CHAT_PATTERN =
  /embed|whisper|tts|speech|audio|dall-?e|image|vision-only|moderation|rerank/i;

function requireServiceRole(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!serviceKey && token === serviceKey;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (!requireServiceRole(req)) return jsonResponse({ error: "Requires service role" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const { data: providers, error: provErr } = await admin
      .from("ai_providers")
      .select("id, slug, base_url, models_path, auth_scheme, openai_compatible")
      .eq("enabled", true)
      .eq("openai_compatible", true)
      .limit(MAX_PROVIDERS_PER_RUN);
    if (provErr) throw provErr;

    const results: { provider: string; found: number; added: number; error?: string }[] = [];

    for (const p of providers ?? []) {
      // Discovery needs a working credential. Prefer any active key, from any
      // user, purely to enumerate the provider's public model catalog — the
      // catalog itself is not user-specific data.
      let secret: string | null = null;
      if (p.auth_scheme !== "none") {
        const { data: key } = await admin
          .from("ai_provider_keys")
          .select("ciphertext, iv")
          .eq("provider_id", p.id)
          .eq("status", "active")
          .limit(1)
          .maybeSingle();

        if (!key) {
          results.push({ provider: p.slug, found: 0, added: 0, error: "no active key available" });
          continue;
        }
        try {
          secret = await decryptSecret(key.ciphertext, key.iv);
        } catch (e) {
          results.push({
            provider: p.slug, found: 0, added: 0,
            error: e instanceof Error ? e.message : "decrypt failed",
          });
          continue;
        }
      }

      const target = p.base_url + (p.models_path ?? "/models");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let modelIds: string[] = [];
      try {
        const headers: Record<string, string> = {};
        if (p.auth_scheme === "bearer" && secret) headers["Authorization"] = `Bearer ${secret}`;
        else if (p.auth_scheme === "x-api-key" && secret) headers["x-api-key"] = secret;

        const resp = await fetch(target, { headers, signal: controller.signal });
        if (!resp.ok) {
          results.push({ provider: p.slug, found: 0, added: 0, error: `HTTP ${resp.status}` });
          continue;
        }
        const body = await resp.json();
        // OpenAI-compatible schema: { data: [{ id: string, ... }, ...] }
        modelIds = Array.isArray(body?.data)
          ? body.data.map((m: { id?: string }) => m.id).filter((id: unknown): id is string => typeof id === "string")
          : [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ provider: p.slug, found: 0, added: 0, error: msg });
        continue;
      } finally {
        clearTimeout(timer);
      }

      const chatCandidates = modelIds.filter((id) => !NON_CHAT_PATTERN.test(id));

      const { data: existing } = await admin
        .from("ai_models")
        .select("model_id")
        .eq("provider_id", p.id);
      const known = new Set((existing ?? []).map((m) => m.model_id));

      const toAdd = chatCandidates.filter((id) => !known.has(id));

      if (toAdd.length > 0) {
        const { error: insErr } = await admin.from("ai_models").insert(
          toAdd.map((model_id) => ({
            provider_id: p.id,
            model_id,
            label: model_id,
            kinds: ["auto"],
            free: p.openai_compatible ? true : false,
            enabled: true,
            canary_passed: false, // never routable until ai-canary says so
            discovery_source: "auto",
          })),
        );
        if (insErr) {
          results.push({ provider: p.slug, found: chatCandidates.length, added: 0, error: insErr.message });
          continue;
        }
      }

      results.push({ provider: p.slug, found: chatCandidates.length, added: toAdd.length });
    }

    return jsonResponse({
      providers_scanned: results.length,
      total_added: results.reduce((sum, r) => sum + r.added, 0),
      results,
      hint: "Newly discovered models are NOT routable until ai-canary verifies them.",
    });
  } catch (e) {
    console.error("ai-discover error:", e);
    return jsonResponse({ error: "Discovery sweep failed" }, 500);
  }
});
