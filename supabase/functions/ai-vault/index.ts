/**
 * ai-vault — credential management for AI providers.
 *
 * Invariant: a raw provider key enters through /add and is never returned by
 * any endpoint thereafter. There is no "reveal" action, deliberately. If a key
 * is lost, it is re-entered from the provider's own dashboard, not recovered
 * from here.
 *
 * Routes:
 *   POST   /ai-vault/add      { provider_slug, label, key }
 *   GET    /ai-vault/list
 *   POST   /ai-vault/test     { key_id }
 *   POST   /ai-vault/revoke   { key_id }
 *   DELETE /ai-vault/remove?key_id=...
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { jsonResponse, preflight } from "../_shared/cors.ts";
import { decryptSecret, encryptSecret, keyHint } from "../_shared/crypto.ts";
import { probeProviderKey, statusForProbe } from "../_shared/probe.ts";

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
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean)[1] ?? "";

  try {
    // ── POST /add ────────────────────────────────────────────────────────────
    if (req.method === "POST" && action === "add") {
      const { provider_slug, label, key } = await req.json();

      if (!provider_slug || typeof provider_slug !== "string") {
        return jsonResponse({ error: "provider_slug required" }, 400);
      }
      if (typeof key !== "string" || key.trim().length < 8) {
        return jsonResponse({ error: "key must be at least 8 characters" }, 400);
      }
      const cleanLabel = String(label ?? "").trim().slice(0, 100) || "default";

      const { data: provider, error: pErr } = await admin
        .from("ai_providers")
        .select("id, slug")
        .eq("slug", provider_slug)
        .single();
      if (pErr || !provider) {
        return jsonResponse({ error: `Unknown provider: ${provider_slug}` }, 404);
      }

      const raw = key.trim();
      const { ciphertext, iv } = await encryptSecret(raw);

      const { data: inserted, error } = await admin
        .from("ai_provider_keys")
        .insert({
          user_id: user.id,
          provider_id: provider.id,
          label: cleanLabel,
          ciphertext,
          iv,
          key_hint: keyHint(raw),
          status: "active",
        })
        .select("id, label, key_hint, status, created_at")
        .single();
      if (error) throw error;

      // Metadata only. The raw key is now unrecoverable through this API.
      return jsonResponse({ key: inserted, provider: provider.slug });
    }

    // ── GET /list ────────────────────────────────────────────────────────────
    if (req.method === "GET" && action === "list") {
      const { data, error } = await admin
        .from("ai_provider_keys")
        .select(
          "id, provider_id, label, key_hint, status, last_error, cooldown_until, " +
            "success_count, failure_count, last_used_at, created_at, " +
            "ai_providers(slug, label, free_tier, enabled)",
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return jsonResponse({ keys: data });
    }

    // ── POST /test ───────────────────────────────────────────────────────────
    // Live probe: decrypt, call the provider's models endpoint, record the
    // result. This is the same signal the scheduled prober writes, so a manual
    // test and an automated one are indistinguishable to the router.
    if (req.method === "POST" && action === "test") {
      const { key_id } = await req.json();
      if (!key_id) return jsonResponse({ error: "key_id required" }, 400);

      const { data: row, error } = await admin
        .from("ai_provider_keys")
        .select("id, ciphertext, iv, ai_providers(slug, base_url, models_path, auth_scheme)")
        .eq("id", key_id)
        .eq("user_id", user.id)
        .single();
      if (error || !row) return jsonResponse({ error: "Key not found" }, 404);

      const provider = row.ai_providers as unknown as {
        slug: string; base_url: string; models_path: string | null; auth_scheme: string;
      };

      let plaintext: string;
      try {
        plaintext = await decryptSecret(row.ciphertext, row.iv);
      } catch (e) {
        await admin.from("ai_provider_keys")
          .update({ status: "dead", last_error: e instanceof Error ? e.message : "decrypt failed" })
          .eq("id", key_id);
        return jsonResponse({ ok: false, error: "Decryption failed" }, 500);
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
        last_used_at: new Date().toISOString(),
        last_probed_at: new Date().toISOString(),
      }).eq("id", key_id);

      await admin.from("ai_route_events").insert({
        user_id: user.id,
        provider_slug: provider.slug,
        model_id: "__probe__",
        key_id,
        outcome: result.ok
          ? "ok"
          : result.httpStatus === 401 || result.httpStatus === 403
          ? "auth"
          : "server",
        http_status: result.httpStatus || null,
        latency_ms: result.latencyMs,
        error: result.ok ? null : result.detail?.slice(0, 500) ?? null,
      });

      return jsonResponse({
        ok: result.ok,
        http_status: result.httpStatus,
        latency_ms: result.latencyMs,
        detail: result.detail,
      });
    }

    // ── POST /revoke ─────────────────────────────────────────────────────────
    if (req.method === "POST" && action === "revoke") {
      const { key_id } = await req.json();
      if (!key_id) return jsonResponse({ error: "key_id required" }, 400);

      const { error } = await admin.from("ai_provider_keys")
        .update({ status: "disabled" })
        .eq("id", key_id)
        .eq("user_id", user.id);
      if (error) throw error;
      return jsonResponse({ revoked: true });
    }

    // ── DELETE /remove ───────────────────────────────────────────────────────
    if (req.method === "DELETE" && action === "remove") {
      const keyId = url.searchParams.get("key_id");
      if (!keyId) return jsonResponse({ error: "key_id required" }, 400);

      const { error } = await admin.from("ai_provider_keys")
        .delete()
        .eq("id", keyId)
        .eq("user_id", user.id);
      if (error) throw error;
      return jsonResponse({ removed: true });
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (e) {
    // Never echo the exception verbatim to the client — vault errors can carry
    // fragments of decrypted material in their messages.
    console.error("ai-vault error:", e);
    return jsonResponse({ error: "Vault operation failed" }, 500);
  }
});
