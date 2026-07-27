import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import {
  Shield, Plus, Trash2, ArrowLeft, Loader2, RefreshCw,
  CheckCircle2, XCircle, Clock, Ban, Activity,
} from "lucide-react";
import {
  addKey, listKeys, testKey, revokeKey, removeKey,
  listProviders, listRouteEvents, getFabricSettings, describeKeyStatus,
  type ProviderKey, type Provider, type FabricSettings,
} from "@/lib/jackie-providers";

type RouteEvent = {
  id: string;
  provider_slug: string | null;
  model_id: string | null;
  attempt: number;
  outcome: string;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
};

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  active: CheckCircle2,
  rate_limited: Clock,
  quota_exhausted: Clock,
  dead: XCircle,
  disabled: Ban,
};

const OUTCOME_COLOR: Record<string, string> = {
  ok: "text-emerald-500",
  auth: "text-red-500",
  quota: "text-orange-500",
  rate: "text-yellow-500",
  timeout: "text-orange-500",
  server: "text-orange-500",
  content: "text-purple-500",
  badreq: "text-red-500",
  exhausted: "text-red-500",
};

export default function ProviderVault() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<"keys" | "health" | "events">("keys");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [events, setEvents] = useState<RouteEvent[]>([]);
  const [settings, setSettings] = useState<FabricSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [p, k] = await Promise.all([listProviders(), listKeys()]);
      setProviders(p);
      setKeys(k);
      try {
        setSettings(await getFabricSettings());
      } catch {
        // Phase 2 migration not applied yet on this project — degrade quietly.
        setSettings(null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load vault");
    }
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      setEvents((await listRouteEvents(50)) as RouteEvent[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load routing events");
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    fetchAll().finally(() => setLoading(false));
  }, [user, fetchAll]);

  useEffect(() => {
    if (activeTab === "events") fetchEvents();
  }, [activeTab, fetchEvents]);

  const handleAdd = async () => {
    if (!selectedProvider) { toast.error("Choose a provider"); return; }
    if (newKey.trim().length < 8) { toast.error("Key looks too short"); return; }
    setAdding(true);
    try {
      await addKey(selectedProvider, newLabel.trim() || "default", newKey.trim());
      toast.success("Key stored — it cannot be viewed again, only tested or removed");
      setShowAdd(false);
      setNewLabel("");
      setNewKey("");
      setSelectedProvider("");
      await fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add key");
    } finally {
      setAdding(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const r = await testKey(id);
      if (r.ok) toast.success(`Reachable — ${r.latency_ms}ms`);
      else toast.error(`Failed (${r.http_status || "network"}): ${r.detail ?? "no detail"}`);
      await fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTestingId(null);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeKey(id);
      toast.success("Key revoked");
      await fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Revoke failed");
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeKey(id);
      toast.success("Key removed");
      await fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Remove failed");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={24} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border px-4 py-3 flex items-center gap-3">
        <a href="/" className="p-2 rounded-md hover:bg-secondary transition-colors">
          <ArrowLeft size={16} className="text-muted-foreground" />
        </a>
        <Shield size={20} className="text-primary" />
        <h1 className="font-mono text-sm font-bold tracking-wide">AI Provider Vault</h1>
        {settings && !settings.routing_enabled && (
          <span className="ml-2 px-2 py-0.5 rounded-md bg-red-500/15 text-red-500 font-mono text-[10px] font-bold">
            ROUTING PAUSED
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {(["keys", "health", "events"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 rounded-md font-mono text-[11px] transition-colors capitalize ${
                activeTab === tab ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">

          {/* ── KEYS TAB ── */}
          {activeTab === "keys" && (
            <>
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">
                  {keys.length} credential{keys.length !== 1 ? "s" : ""} across {providers.length} providers
                </span>
                <button
                  onClick={() => setShowAdd(!showAdd)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-mono text-xs hover:bg-primary/90 transition-colors"
                >
                  <Plus size={12} /> Add Key
                </button>
              </div>

              {showAdd && (
                <div className="p-4 rounded-md border border-border bg-secondary/20 space-y-3">
                  <div>
                    <label className="font-mono text-[10px] text-muted-foreground uppercase">Provider</label>
                    <select
                      value={selectedProvider}
                      onChange={(e) => setSelectedProvider(e.target.value)}
                      className="w-full mt-1 px-3 py-2 rounded-md border border-border bg-background font-mono text-sm"
                    >
                      <option value="">Choose a provider…</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.slug}>
                          {p.label} {p.free_tier ? "(free tier)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Label (e.g. primary)"
                    maxLength={100}
                    className="w-full px-3 py-2 rounded-md border border-border bg-background font-mono text-sm placeholder:text-muted-foreground"
                  />
                  <input
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="Paste the raw API key — shown only until you leave this field"
                    type="password"
                    className="w-full px-3 py-2 rounded-md border border-border bg-background font-mono text-sm placeholder:text-muted-foreground"
                  />
                  <p className="font-mono text-[10px] text-muted-foreground">
                    Encrypted before storage. There is no way to view this key again through this
                    interface once saved — only test, revoke, or remove.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleAdd}
                      disabled={adding}
                      className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-mono text-xs disabled:opacity-50"
                    >
                      {adding ? "Storing…" : "Store Key"}
                    </button>
                    <button
                      onClick={() => setShowAdd(false)}
                      className="px-3 py-1.5 rounded-md border border-border font-mono text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {keys.map((k) => {
                  const Icon = STATUS_ICON[k.status] ?? Shield;
                  return (
                    <div key={k.id} className="p-3 rounded-md border border-border flex items-center gap-3">
                      <Icon
                        size={16}
                        className={
                          k.status === "active" ? "text-emerald-500"
                          : k.status === "dead" ? "text-red-500"
                          : k.status === "disabled" ? "text-muted-foreground"
                          : "text-yellow-500"
                        }
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs font-medium truncate">
                          {k.ai_providers?.label ?? k.provider_id} — {k.label}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          ****{k.key_hint} · {describeKeyStatus(k)}
                          {k.success_count + k.failure_count > 0 &&
                            ` · ${k.success_count}/${k.success_count + k.failure_count} ok`}
                        </div>
                      </div>
                      <button
                        onClick={() => handleTest(k.id)}
                        disabled={testingId === k.id}
                        title="Test connectivity"
                        className="p-1.5 rounded-md hover:bg-secondary"
                      >
                        <RefreshCw size={13} className={testingId === k.id ? "animate-spin" : ""} />
                      </button>
                      {k.status !== "disabled" && (
                        <button
                          onClick={() => handleRevoke(k.id)}
                          title="Revoke"
                          className="p-1.5 rounded-md hover:bg-secondary text-yellow-500"
                        >
                          <Ban size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => handleRemove(k.id)}
                        title="Remove"
                        className="p-1.5 rounded-md hover:bg-secondary text-red-500"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
                {keys.length === 0 && (
                  <div className="text-center py-8 font-mono text-xs text-muted-foreground">
                    No credentials yet. Add one from a provider you actually hold an account with.
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── HEALTH TAB ── */}
          {activeTab === "health" && (
            <div className="space-y-2">
              {settings && (
                <div className="p-3 rounded-md border border-border font-mono text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Routing</span>
                    <span className={settings.routing_enabled ? "text-emerald-500" : "text-red-500"}>
                      {settings.routing_enabled ? "enabled" : `paused${settings.disabled_reason ? ` — ${settings.disabled_reason}` : ""}`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Hourly budget / user</span>
                    <span>{settings.max_route_events_per_user_per_hour} attempts</span>
                  </div>
                </div>
              )}
              {providers.map((p) => {
                const providerKeys = keys.filter((k) => k.provider_id === p.id);
                const cooling = p.cooldown_until && new Date(p.cooldown_until) > new Date();
                return (
                  <div key={p.id} className="p-3 rounded-md border border-border flex items-center justify-between">
                    <div>
                      <div className="font-mono text-xs font-medium">{p.label}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {providerKeys.length} key{providerKeys.length !== 1 ? "s" : ""}
                        {p.free_tier ? " · free tier" : ""}
                      </div>
                    </div>
                    <span className={`font-mono text-[10px] ${cooling ? "text-orange-500" : p.enabled ? "text-emerald-500" : "text-muted-foreground"}`}>
                      {cooling ? "circuit-broken" : p.enabled ? "up" : "disabled"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── EVENTS TAB ── */}
          {activeTab === "events" && (
            <div className="space-y-1">
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs text-muted-foreground flex items-center gap-1">
                  <Activity size={12} /> Last {events.length} routing attempts
                </span>
                <button onClick={fetchEvents} className="p-1.5 rounded-md hover:bg-secondary">
                  <RefreshCw size={13} />
                </button>
              </div>
              {events.map((e) => (
                <div key={e.id} className="px-3 py-2 rounded-md border border-border flex items-center gap-2 font-mono text-[11px]">
                  <span className={OUTCOME_COLOR[e.outcome] ?? "text-muted-foreground"}>{e.outcome}</span>
                  <span className="text-muted-foreground">{e.provider_slug ?? "—"}</span>
                  <span className="truncate flex-1 text-muted-foreground">{e.model_id ?? "—"}</span>
                  {e.latency_ms != null && <span className="text-muted-foreground">{e.latency_ms}ms</span>}
                  <span className="text-muted-foreground/60">{new Date(e.created_at).toLocaleTimeString()}</span>
                </div>
              ))}
              {events.length === 0 && (
                <div className="text-center py-8 font-mono text-xs text-muted-foreground">
                  No routing attempts recorded yet.
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
