/**
 * ai-probe — scheduled health sweep across every stored credential.
 *
 * Invoked by pg_cron+pg_net where available (see the migration), or by an
 * external scheduler (GitHub Actions cron, Supabase's own scheduled triggers)
 * hitting this URL with the service role key otherwise.
 *
 * Why this exists: a key that fails once gets cooled down by jackie-route and
 * stays cooled until a live user request happens to land on it again after
 * the cooldown expires. On a quiet fabric that could be hours. This sweep
 * finds recovered keys proactively and finds newly-dead ones before a user
 * request has to discover that the hard way.
 *
 * NOT for arbitrary invocation: this endpoint requires the service role key,
 * not a user JWT, precisely because it must read every user's keys to sweep
 * them. It is not reachable with a client anon/publishable key.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { jsonResponse, preflight } from "../_shared/cors.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { probeProviderKey, statusForProbe } from "../_shared/probe.ts";

// Ceiling per invocation. A scheduled sweep runs often enough that the whole
// pool gets covered over a few cycles — no single run needs to (or should)
// probe everything at once and risk a long-running, timeout-prone request.
const MAX_KEYS_PER_SWEEP = 50;
const CONCURRENCY = 5;

function requireServiceRole(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!serviceKey && token === serviceKey;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  if (!requireServiceRole(req)) {
    return jsonResponse({ error: "Requires service role" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const { data: settings } = await admin
      .from("ai_fabric_settings")
      .select("routing_enabled")
      .eq("id", 1)
      .single();

    // A paused fabric still deserves fresh health data for when it resumes —
    // the kill switch stops routing, not observation.

    const { data: keys, error } = await admin
      .from("ai_provider_keys")
      .select(
        "id, user_id, ciphertext, iv, ai_providers(slug, base_url, models_path, auth_scheme, enabled)",
      )
      .neq("status", "disabled")
      .order("last_probed_at", { ascending: true, nullsFirst: true })
      .limit(MAX_KEYS_PER_SWEEP);
    if (error) throw error;

    const targets = (keys ?? []).filter((k) => {
      const p = k.ai_providers as unknown as { enabled: boolean } | null;
      return p?.enabled;
    });

    const outcomes = await mapWithConcurrency(targets, CONCURRENCY, async (row) => {
      const provider = row.ai_providers as unknown as {
        slug: string; base_url: string; models_path: string | null; auth_scheme: string;
      };

      let plaintext: string | null = null;
      let decryptFailed = false;
      try {
        plaintext = row.ciphertext && row.iv ? await decryptSecret(row.ciphertext, row.iv) : null;
      } catch {
        decryptFailed = true;
      }

      if (decryptFailed) {
        await admin.from("ai_provider_keys").update({
          status: "dead",
          last_error: "Decryption failed during probe — AI_VAULT_KEY may have changed",
          last_probed_at: new Date().toISOString(),
        }).eq("id", row.id);
        return { keyId: row.id, provider: provider.slug, ok: false, reason: "decrypt_failed" };
      }

      const result = await probeProviderKey({
        baseUrl: provider.base_url,
        modelsPath: provider.models_path,
        authScheme: provider.auth_scheme,
        secret: plaintext,
      });

      await admin.from("ai_provider_keys").update({
        status: statusForProbe(result),
        last_error: result.ok ? null : result.detail?.slice(0, 500) ?? null,
        last_probed_at: new Date().toISOString(),
      }).eq("id", row.id);

      await admin.from("ai_route_events").insert({
        user_id: row.user_id,
        provider_slug: provider.slug,
        model_id: "__probe__",
        key_id: row.id,
        outcome: result.ok
          ? "ok"
          : result.httpStatus === 401 || result.httpStatus === 403
          ? "auth"
          : "server",
        http_status: result.httpStatus || null,
        latency_ms: result.latencyMs,
        error: result.ok ? null : result.detail?.slice(0, 500) ?? null,
      });

      return { keyId: row.id, provider: provider.slug, ok: result.ok };
    });

    await admin.rpc("recompute_ai_health");

    return jsonResponse({
      swept: outcomes.length,
      healthy: outcomes.filter((o) => o.ok).length,
      unhealthy: outcomes.filter((o) => !o.ok).length,
      routing_enabled: settings?.routing_enabled ?? true,
    });
  } catch (e) {
    console.error("ai-probe error:", e);
    return jsonResponse({ error: "Probe sweep failed" }, 500);
  }
});
