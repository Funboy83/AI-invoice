/**
 * Structured, privacy-conscious timing logs for chat jobs (one JSON line per event, greppable by `"src":"chat-job"`).
 *
 * Only job ids, durations, counts, token usage and short machine codes are ever logged. The logger REFUSES free text:
 * a string field must look like an identifier/code (letters, digits, `_ . : -`, max 64 chars); anything else — order
 * text, customer or product names, error messages, model output — is replaced with "[redacted]". Callers pass error
 * *codes* (e.g. `anthropic_429`, `timeout`), never messages.
 */
type Field = string | number | boolean | null | undefined;

const SAFE_STRING = /^[A-Za-z0-9_.:\-]{1,64}$/;

function safe(value: Field): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  if (typeof value === "string") return SAFE_STRING.test(value) ? value : "[redacted]";
  return value;
}

/** Where lines go. Tests swap this to capture output. */
export const logSink = { write: (line: string) => console.info(line) };

export function logJob(event: string, jobId: string, fields: Record<string, Field> = {}): void {
  const out: Record<string, unknown> = { src: "chat-job", event, jobId: safe(jobId) };
  for (const [k, v] of Object.entries(fields)) out[k] = safe(v);
  logSink.write(JSON.stringify(out));
}

/** Runs `fn`, returning its result and elapsed milliseconds (even when it throws, via the callback). */
export async function timed<T>(fn: () => Promise<T>, onDone?: (ms: number, ok: boolean) => void): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    onDone?.(performance.now() - start, true);
    return result;
  } catch (err) {
    onDone?.(performance.now() - start, false);
    throw err;
  }
}
