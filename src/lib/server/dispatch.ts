import { logJob } from "./jobLog";

/**
 * Base URL this deployment can be reached at by ITSELF. Deliberately never derived from request headers: the
 * continuation call carries a secret, and a forged Host header must not be able to redirect it elsewhere.
 */
export function workerBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NODE_ENV !== "production") return `http://localhost:${process.env.PORT ?? 3000}`;
  return null;
}

/**
 * Starts a FRESH invocation for a job this invocation could not finish (out of time), so it continues right away
 * with its own time budget — no browser, cron or scheduler involved. Returns whether the request was accepted.
 * The endpoint is authenticated with CRON_SECRET; without it (or without a reachable base URL) nothing is sent and
 * the job simply stays queued until the app is opened or a scheduler sweeps it.
 */
export async function dispatchContinuation(jobId: string): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logJob("continuation", jobId, { ok: false, reason: "no_secret" });
    return false;
  }
  const base = workerBaseUrl();
  if (!base) {
    logJob("continuation", jobId, { ok: false, reason: "no_base_url" });
    return false;
  }
  const start = performance.now();
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
    // Lets the call through Vercel Deployment Protection when "Protection Bypass for Automation" is enabled.
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const res = await fetch(`${base}/api/chat/jobs/${encodeURIComponent(jobId)}/continue`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    logJob("continuation", jobId, { ok: res.ok, reason: res.ok ? "ok" : `http_${res.status}`, ms: performance.now() - start });
    return res.ok;
  } catch {
    logJob("continuation", jobId, { ok: false, reason: "network", ms: performance.now() - start });
    return false;
  }
}
