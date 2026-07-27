/**
 * Shared health-probe logic. Used by both ai-vault/test (one key, on demand,
 * user-triggered) and ai-probe (all keys, scheduled, service-triggered) so the
 * signal both paths write is identical — the router does not need to know
 * which one produced a given health data point.
 */

const PROBE_TIMEOUT_MS = 10_000;

export type ProbeResult = {
  ok: boolean;
  httpStatus: number;
  latencyMs: number;
  detail: string | null;
};

export async function probeProviderKey(opts: {
  baseUrl: string;
  modelsPath: string | null;
  authScheme: string;
  secret: string | null;
}): Promise<ProbeResult> {
  const target = opts.baseUrl + (opts.modelsPath ?? "/models");
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (opts.authScheme === "bearer" && opts.secret) {
      headers["Authorization"] = `Bearer ${opts.secret}`;
    } else if (opts.authScheme === "x-api-key" && opts.secret) {
      headers["x-api-key"] = opts.secret;
    }

    const resp = await fetch(target, { headers, signal: controller.signal });
    const latencyMs = Date.now() - started;

    if (resp.ok) {
      return { ok: true, httpStatus: resp.status, latencyMs, detail: null };
    }
    const detail = (await resp.text()).slice(0, 300);
    return { ok: false, httpStatus: resp.status, latencyMs, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      httpStatus: 0,
      latencyMs: Date.now() - started,
      detail: /abort/i.test(msg) ? "timeout" : msg.slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Map a probe outcome to the same key-status vocabulary the router uses. */
export function statusForProbe(result: ProbeResult): string {
  if (result.ok) return "active";
  if (result.httpStatus === 401 || result.httpStatus === 403) return "dead";
  if (result.httpStatus === 429) return "rate_limited";
  if (result.httpStatus === 402) return "quota_exhausted";
  return "active"; // transient/server-side — do not punish the key for it
}
