// Jackie Provider Vault — client API.
//
// Credentials are write-only from the browser's perspective: addKey() sends a
// raw key up once, and nothing in this module can ever read one back. The list
// endpoint returns metadata (label, last-4, health) and nothing else, because
// the ciphertext column is not reachable from an authenticated client at all.

import { supabase } from "@/integrations/supabase/client";

const VAULT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-vault`;

export type KeyStatus =
  | "active" | "rate_limited" | "quota_exhausted" | "dead" | "disabled";

export type ProviderKey = {
  id: string;
  provider_id: string;
  label: string;
  key_hint: string;
  status: KeyStatus;
  last_error: string | null;
  cooldown_until: string | null;
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
  created_at: string;
  ai_providers: {
    slug: string;
    label: string;
    free_tier: boolean;
    enabled: boolean;
  } | null;
};

export type Provider = {
  id: string;
  slug: string;
  label: string;
  free_tier: boolean;
  enabled: boolean;
  priority: number;
  cooldown_until: string | null;
};

async function vaultCall<T>(
  action: string,
  method: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  let url = `${VAULT_URL}/${action}`;
  if (params) url += `?${new URLSearchParams(params)}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "Vault request failed");
  return data as T;
}

/** Store a provider credential. The raw key is unrecoverable after this call. */
export async function addKey(providerSlug: string, label: string, key: string) {
  return vaultCall<{ key: { id: string; label: string; key_hint: string } }>(
    "add", "POST", { provider_slug: providerSlug, label, key },
  );
}

export async function listKeys(): Promise<ProviderKey[]> {
  const { keys } = await vaultCall<{ keys: ProviderKey[] }>("list", "GET");
  return keys;
}

/** Live probe against the provider. Result feeds the same health signal the router reads. */
export async function testKey(keyId: string) {
  return vaultCall<{ ok: boolean; http_status: number; latency_ms: number; detail: string | null }>(
    "test", "POST", { key_id: keyId },
  );
}

export async function revokeKey(keyId: string) {
  return vaultCall<{ revoked: boolean }>("revoke", "POST", { key_id: keyId });
}

export async function removeKey(keyId: string) {
  return vaultCall<{ removed: boolean }>("remove", "DELETE", undefined, { key_id: keyId });
}

/** Provider catalog. Read-only — the client cannot add or modify upstreams. */
export async function listProviders(): Promise<Provider[]> {
  const { data, error } = await supabase
    .from("ai_providers")
    .select("id, slug, label, free_tier, enabled, priority, cooldown_until")
    .order("priority", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Provider[];
}

/** Recent routing attempts — the audit trail behind every answer. */
export async function listRouteEvents(limit = 100) {
  const { data, error } = await supabase
    .from("ai_route_events")
    .select("id, provider_slug, model_id, attempt, outcome, http_status, latency_ms, error, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export type FabricSettings = {
  routing_enabled: boolean;
  max_route_events_per_user_per_hour: number;
  disabled_reason: string | null;
};

/** Kill-switch + budget state. Read-only from the client by design. */
export async function getFabricSettings(): Promise<FabricSettings> {
  const { data, error } = await supabase
    .from("ai_fabric_settings")
    .select("routing_enabled, max_route_events_per_user_per_hour, disabled_reason")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return data as FabricSettings;
}

/** Human-readable explanation of a key's current state. */
export function describeKeyStatus(k: ProviderKey): string {
  const cooling = k.cooldown_until && new Date(k.cooldown_until) > new Date();
  switch (k.status) {
    case "active":
      return cooling ? "Cooling down" : "Active";
    case "rate_limited":
      return cooling ? "Rate limited — cooling down" : "Rate limited — ready to retry";
    case "quota_exhausted":
      return cooling ? "Quota exhausted — parked" : "Quota may have reset";
    case "dead":
      return "Rejected — re-enter this key";
    case "disabled":
      return "Revoked";
    default:
      return k.status;
  }
}
