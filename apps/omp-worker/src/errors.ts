import { AsyncLocalStorage } from "node:async_hooks";

const codes = new Set([
  "auth",
  "rate_limit",
  "context_limit",
  "network",
  "model_unavailable",
  "model_not_verified",
  "account_required",
  "session_not_found",
  "history_changed",
  "invalid_page",
  "session_busy",
]);
/** Only structured status/code fields and exact local codes cross IPC. */
export function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "operation_failed";
  const value = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  for (const candidate of [value.code, value.message]) {
    if (typeof candidate === "string" && codes.has(candidate)) return candidate;
  }
  switch (value.status ?? value.statusCode) {
    case 401:
    case 403:
      return "auth";
    case 429:
      return "rate_limit";
    case 413:
      return "context_limit";
    case 404:
      return "model_unavailable";
  }
  if (
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(
      String(value.code),
    )
  )
    return "network";
  return "operation_failed";
}

/** Read only a bounded copy of a 400 response to recognize documented codes. */
export async function httpErrorCode(
  response: Response,
): Promise<string | undefined> {
  if (response.ok) return undefined;
  const fallback = safeErrorCode({ status: response.status });
  if (response.status !== 400) return fallback;
  const reader = response.clone().body?.getReader();
  if (!reader) return fallback;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("error_body_timeout")), 1000);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) return fallback;
      chunks.push(chunk.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      [
        "context_length_exceeded",
        "context_window_exceeded",
        "prompt_too_long",
      ].includes(body?.error?.code ?? body?.code)
    )
      return "context_limit";
  } catch {
    /* Raw provider text is never an IPC error. */
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => undefined);
  }
  return fallback;
}

interface ProviderFailure {
  code?: string;
}
/** Each SDK call owns its HTTP classification, including retries and cancellation. */
export class ProviderErrors {
  private readonly calls = new AsyncLocalStorage<ProviderFailure>();
  run<T>(work: (failure: ProviderFailure) => Promise<T>): Promise<T> {
    const failure: ProviderFailure = {};
    return this.calls.run(failure, () => work(failure));
  }
  async fetch(send: () => Promise<Response>): Promise<Response> {
    const failure = this.calls.getStore();
    try {
      const response = await send();
      if (failure) failure.code = await httpErrorCode(response);
      return response;
    } catch (error) {
      if (failure) failure.code = "network";
      throw error;
    }
  }
  terminal(
    failure: ProviderFailure,
    reason: string,
    message?: string,
  ): string | undefined {
    return reason === "error"
      ? (failure.code ?? safeErrorCode({ message }))
      : undefined;
  }
}
