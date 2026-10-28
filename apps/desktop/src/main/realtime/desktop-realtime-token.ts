import {
  type IssuedRealtimeToken,
  issuedRealtimeTokenSchema,
  REALTIME_TOKEN_PATH,
} from "@repo/realtime-contract/protocol";
import {
  SessionRequestCredentialKind,
  sendSessionClApiRequest,
  unwrapApiEnvelope,
} from "../util/api-response-utils.js";

export type DesktopRealtimeTokenDeps = {
  /** The desktop session's access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** May throw when the configured origin is unset or invalid. */
  getApiOrigin: () => string;
  onUnauthorized: (rejectedToken: string) => void;
  fetch?: typeof fetch;
};

/**
 * PLN-2162 decision 12: the main process fetches the realtime token itself,
 * with the session's access token, so `/realtime/token` never reaches the
 * renderer's cloud bridge. Rejects on anything but a well-formed token, and
 * the realtime client retries with backoff, so a 503 while the service is not
 * configured leaves the renderer polling.
 */
export async function fetchDesktopRealtimeToken(
  deps: DesktopRealtimeTokenDeps
): Promise<IssuedRealtimeToken> {
  const token = await deps.getAccessToken();
  if (token === null) {
    throw new Error("Realtime token needs a signed-in desktop session");
  }
  const response = await sendSessionClApiRequest({
    apiOrigin: deps.getApiOrigin(),
    path: REALTIME_TOKEN_PATH,
    method: "POST",
    credential: {
      token,
      credentialKind: SessionRequestCredentialKind.AccessToken,
    },
    timeoutMs: REALTIME_TOKEN_TIMEOUT_MS,
    onUnauthorized: deps.onUnauthorized,
    fetch: deps.fetch,
  });
  if (!response.ok) {
    throw new Error(`Realtime token request failed: HTTP ${response.status}`);
  }
  return issuedRealtimeTokenSchema.parse(
    unwrapApiEnvelope(await response.json())
  );
}

const REALTIME_TOKEN_TIMEOUT_MS = 15_000;
