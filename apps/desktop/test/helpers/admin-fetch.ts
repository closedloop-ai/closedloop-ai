/**
 * @file admin-fetch.ts
 * @description Shared test helper for the vendor Admin API clients
 * (anthropic-admin-client, openai-admin-client, claude-code-analytics-client).
 * Provides a recording fake `fetch` that returns queued JSON bodies in call
 * order and records the URL + headers of each call, so tests can assert that the
 * Admin key travels only in headers (never the URL) and that pagination follows
 * the queued sequence. The network is never touched.
 */
import type {
  AdminFetchLike,
  AdminFetchResponse,
} from "../../src/main/admin-billing.js";

export type RecordedCall = {
  url: string;
  headers: Record<string, string>;
};

/**
 * Build a fake fetch that returns `pages[i]` for the i-th call (clamping to the
 * last page once exhausted) and records each call. `opts.status`/`opts.bodyText`
 * model a non-2xx error body.
 */
export function makeFetch(
  pages: unknown[],
  opts?: { status?: number; bodyText?: string }
): { fetch: AdminFetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetch: AdminFetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const status = opts?.status ?? 200;
    const ok = status >= 200 && status < 300;
    const body = pages[index] ?? pages.at(-1);
    index += 1;
    const response: AdminFetchResponse = {
      ok,
      status,
      json: async () => body,
      text: async () => opts?.bodyText ?? JSON.stringify(body),
    };
    return response;
  };
  return { fetch, calls };
}
