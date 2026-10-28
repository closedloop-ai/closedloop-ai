import type { Socket } from "socket.io-client";
import {
  type DesktopPopHeaders,
  type DesktopPopSigner,
  RELAY_API_KEY_VERIFY_PATH,
} from "../auth/desktop-pop.js";
import {
  buildManagedDesktopPopHeaders,
  type DesktopPopUnavailableReporter,
} from "../auth/desktop-pop-sign-utils.js";
import type { ApiKeyProvenance } from "../settings/api-key-store.js";

/** Builds PoP headers for the relay's API-key verification request. */
export function buildRelayValidationPopHeaders(
  apiKeyProvenance: ApiKeyProvenance,
  signDesktopRequest?: DesktopPopSigner,
  onUnavailable?: DesktopPopUnavailableReporter
): Promise<DesktopPopHeaders | undefined> {
  return buildManagedDesktopPopHeaders({
    apiKeyProvenance,
    signDesktopRequest,
    request: { method: "POST", pathname: RELAY_API_KEY_VERIFY_PATH },
    surface: RELAY_API_KEY_VERIFY_PATH,
    unavailableMessage:
      "PoP signing unavailable for relay validation; continuing bearer-only compatibility mode",
    onUnavailable,
  });
}

/** Refreshes Engine extraHeaders before a manual Socket.IO reconnect. */
export async function refreshRelayValidationPopHeadersForSocket(
  socket: Socket,
  apiKeyProvenance: ApiKeyProvenance,
  signDesktopRequest?: DesktopPopSigner,
  onUnavailable?: DesktopPopUnavailableReporter
): Promise<void> {
  const headers = await buildRelayValidationPopHeaders(
    apiKeyProvenance,
    signDesktopRequest,
    onUnavailable
  );
  socket.io.opts.extraHeaders = headers;
}
