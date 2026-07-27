// Jackie Multi-Model Orchestrator
// Routes tasks to the best model for the job, with fallback + optional parallel execution.
// All model calls go through an edge function (never direct from client).
//
// Transport: calls now land on `jackie-route`, which owns the real failover
// ladder across every configured provider and credential. The static registry
// below is retained because it drives the UI in JackieControl and provides the
// task-kind heuristics; it is no longer the source of truth for what is
// actually routable — the ai_models table is.
//
// While the provider vault is still being populated, `jackie-route` returns 503
// (no routable candidates). That case degrades to the legacy `jackie-orchestrate`
// path so the app keeps working throughout the migration rather than going dark
// the moment this ships.

import { supabase } from "@/integrations/supabase/client";

export type TaskKind = "reasoning" | "coding" | "fast" | "long-context" | "auto";

export type ModelEntry = {
  id: string;
  label: string;
  kind: TaskKind[];
  cost: 1 | 2 | 3;
  speed: 1 | 2 | 3; // 3 = fastest
};

export const ORCHESTRATOR_MODELS: ModelEntry[] = [
  { id: "google/gemini-2.5-pro",         label: "Gemini 2.5 Pro",   kind: ["reasoning", "long-context"], cost: 3, speed: 1 },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash",   kind: ["fast", "coding", "auto"],    cost: 2, speed: 3 },
  { id: "google/gemini-2.5-flash",       label: "Gemini 2.5 Flash", kind: ["fast", "auto"],              cost: 2, speed: 3 },
  { id: "google/gemini-2.5-flash-lite",  label: "Gemini Lite",      kind: ["fast"],                      cost: 1, speed: 3 },
  { id: "openai/gpt-5",                  label: "GPT-5",            kind: ["reasoning", "coding"],       cost: 3, speed: 1 },
  { id: "openai/gpt-5-mini",             label: "GPT-5 Mini",       kind: ["coding", "auto"],            cost: 2, speed: 2 },
];

const HEURISTICS: { test: RegExp; kind: TaskKind }[] = [
  { test: /\b(code|function|refactor|bug|typescript|react|sql|api|class|component)\b/i, kind: "coding" },
  { test: /\b(why|explain|reason|prove|analy[sz]e|strategy|plan|architecture|trade-?off)\b/i, kind: "reasoning" },
  { test: /\b(summari[sz]e|tl;dr|book|chapter|document|long|transcript|article)\b/i, kind: "long-context" },
  { test: /\b(quick|fast|short|one-?liner|tldr|hi|hello|status)\b/i, kind: "fast" },
];

export function pickKind(prompt: string): TaskKind {
  for (const h of HEURISTICS) if (h.test.test(prompt)) return h.kind;
  return prompt.length > 4000 ? "long-context" : "fast";
}

export function pickModel(kind: TaskKind, override?: string): ModelEntry {
  if (override) {
    const found = ORCHESTRATOR_MODELS.find((m) => m.id === override);
    if (found) return found;
  }
  const candidates = ORCHESTRATOR_MODELS.filter((m) => m.kind.includes(kind));
  if (candidates.length === 0) return ORCHESTRATOR_MODELS[1];
  // Prefer best fit: reasoning/long-context → highest cost (most capable); fast → highest speed
  if (kind === "reasoning" || kind === "long-context") {
    return candidates.sort((a, b) => b.cost - a.cost)[0];
  }
  return candidates.sort((a, b) => b.speed - a.speed)[0];
}

export type OrchestrateResult = {
  modelUsed: string;
  kind: TaskKind;
  output: string;
  attemptedFallback: boolean;
  durationMs: number;
  /** Upstream that actually served the request, when routed via jackie-route. */
  provider?: string;
  /** True when the legacy single-gateway path served this request. */
  legacy?: boolean;
};

const ROUTE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jackie-route`;

/**
 * Call the multi-provider router. Returns null when no candidates are routable
 * yet, which is the signal to degrade to the legacy gateway rather than fail.
 */
async function routeViaFabric(opts: {
  prompt: string;
  system?: string;
  kind: TaskKind;
  modelOverride?: string;
}): Promise<{ output: string; model: string; provider: string; attempt: number } | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  const messages = [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: opts.prompt },
  ];

  const resp = await fetch(ROUTE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({
      messages,
      stream: false,
      kind: opts.kind === "auto" ? undefined : opts.kind,
      model: opts.modelOverride,
    }),
  });

  // 503 = vault not populated yet. Caller degrades instead of surfacing an error.
  if (resp.status === 503) return null;

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Router failed (${resp.status})`);

  const output = data?.choices?.[0]?.message?.content ?? "";
  return {
    output,
    model: resp.headers.get("X-Jackie-Model") ?? opts.modelOverride ?? "unknown",
    provider: resp.headers.get("X-Jackie-Provider") ?? "unknown",
    attempt: Number(resp.headers.get("X-Jackie-Attempt") ?? 1),
  };
}

export async function orchestrate(opts: {
  prompt: string;
  system?: string;
  kind?: TaskKind;
  modelOverride?: string;
}): Promise<OrchestrateResult> {
  const kind: TaskKind = opts.kind && opts.kind !== "auto" ? opts.kind : pickKind(opts.prompt);
  const primary = pickModel(kind, opts.modelOverride);
  const fallback = ORCHESTRATOR_MODELS.find(
    (m) => m.id !== primary.id && m.kind.includes(kind)
  ) || ORCHESTRATOR_MODELS[1];

  const started = Date.now();
  let attemptedFallback = false;

  const invoke = async (modelId: string) => {
    const { data, error } = await supabase.functions.invoke("jackie-orchestrate", {
      body: { model: modelId, system: opts.system, prompt: opts.prompt },
    });
    if (error) throw new Error(error.message || "orchestrate failed");
    if ((data as any)?.error) throw new Error((data as any).error);
    return (data as { output: string }).output;
  };

  // Preferred path: the provider fabric, which handles failover internally.
  try {
    const routed = await routeViaFabric({
      prompt: opts.prompt, system: opts.system, kind, modelOverride: opts.modelOverride,
    });
    if (routed) {
      return {
        modelUsed: routed.model,
        kind,
        output: routed.output,
        // The router already walked its ladder; >1 attempt means it fell over.
        attemptedFallback: routed.attempt > 1,
        durationMs: Date.now() - started,
        provider: routed.provider,
      };
    }
  } catch {
    // Router reachable but failed outright — fall through to the legacy path
    // rather than dropping the user's request on the floor.
  }

  // Legacy path: single gateway, static primary/fallback pair.
  try {
    const output = await invoke(primary.id);
    return { modelUsed: primary.id, kind, output, attemptedFallback, durationMs: Date.now() - started, legacy: true };
  } catch (e) {
    attemptedFallback = true;
    const output = await invoke(fallback.id);
    return { modelUsed: fallback.id, kind, output, attemptedFallback, durationMs: Date.now() - started, legacy: true };
  }
}

// Parallel multi-model execution: run the same prompt on N models, return all.
export async function orchestrateParallel(opts: {
  prompt: string;
  system?: string;
  models: string[];
}): Promise<{ modelId: string; output: string; error?: string }[]> {
  return Promise.all(
    opts.models.map(async (modelId) => {
      try {
        const r = await orchestrate({ prompt: opts.prompt, system: opts.system, modelOverride: modelId });
        return { modelId, output: r.output };
      } catch (e) {
        return { modelId, output: "", error: e instanceof Error ? e.message : "failed" };
      }
    })
  );
}
