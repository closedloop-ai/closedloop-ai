import { createHash } from "node:crypto";
import { DOC_SYNC_CHANGES_PATH } from "@repo/realtime-contract/doc-sync-internal";
import type { SendChangeCallback } from "./change-callback-queue";

/** The headers that authenticate a body whose hex SHA-256 is `bodySha256`. */
export type CallbackSigner = (
  bodySha256: string
) => Promise<Record<string, string>>;

export const DEFAULT_CALLBACK_TIMEOUT_MS = 5000;

/**
 * PLN-2200 T-7.6: POSTs each callback as JSON to the API's
 * `DOC_SYNC_CHANGES_PATH` with the headers `sign` returns. A 2xx is
 * delivered; another status is a refusal the queue retries. A signing or
 * network failure throws, which the queue also retries.
 */
export function createCallbackSender({
  url,
  sign,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
}: {
  url: string;
  sign: CallbackSigner;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): SendChangeCallback {
  const endpoint = `${url.replace(TRAILING_SLASHES, "")}${DOC_SYNC_CHANGES_PATH}`;
  return async (callback) => {
    const body = JSON.stringify(callback);
    const signed = await sign(createHash("sha256").update(body).digest("hex"));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...signed, "content-type": "application/json" },
      body,
      // The signed headers are a credential for their lifetime; never replay them elsewhere.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true }
      : { ok: false, httpStatus: response.status };
  };
}

const TRAILING_SLASHES = /\/+$/;
