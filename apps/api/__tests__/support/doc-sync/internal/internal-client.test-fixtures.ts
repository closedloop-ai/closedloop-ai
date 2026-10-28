import type { InternalServiceConfig } from "@repo/realtime-server/internal-call";
import { vi } from "vitest";

export const OIDC_TOKEN = "header.payload-for-the-doc-sync-audience.signature";
export const CONFIG: InternalServiceConfig = {
  url: "http://doc-sync.internal:3050",
  oidcAudience: "doc-sync-internal-fixture",
};
/** AbortSignal.timeout runs on Node's own timers, which fake timers do not reach. */
export const STALL_TIMEOUT_MS = 20;
export const STALL_TEST_TIMEOUT_MS = 5000;

type FetchCall = [URL | RequestInfo, RequestInit | undefined];

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function answering(...responses: Response[]) {
  const queue = [...responses];
  return vi.fn((_url: URL | RequestInfo, _init?: RequestInit) => {
    const next = queue.shift();
    return next
      ? Promise.resolve(next)
      : Promise.reject(new Error("no response queued"));
  });
}

/** A fetch that answers only when its signal aborts. */
export function stalling() {
  return vi.fn(
    (_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        );
      })
  );
}

export function sent(fetch: ReturnType<typeof answering>, index = 0) {
  const [url, init] = (fetch.mock.calls[index] ?? []) as FetchCall;
  return {
    url: String(url),
    method: init?.method,
    headers: init?.headers,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}
