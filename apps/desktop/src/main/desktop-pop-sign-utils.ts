import type { ApiKeyProvenance } from "./api-key-store.js";
import {
  type DesktopPopHeaders,
  type DesktopPopSigner,
  type DesktopPopSigningRequest,
  getDesktopPopUnavailableReason,
} from "./desktop-pop.js";
import { gatewayLog } from "./gateway-logger.js";

export type DesktopPopUnavailableReporter = (
  surface: string,
  reason: string
) => void;

export type BuildManagedDesktopPopHeadersOptions = {
  apiKeyProvenance: ApiKeyProvenance;
  signDesktopRequest?: DesktopPopSigner;
  request: DesktopPopSigningRequest;
  surface: string;
  unavailableMessage: string;
  onUnavailable?: DesktopPopUnavailableReporter;
};

/**
 * Signs a managed-key PoP request, logging and reporting a redacted fallback once.
 */
export async function buildManagedDesktopPopHeaders(
  options: BuildManagedDesktopPopHeadersOptions
): Promise<DesktopPopHeaders | undefined> {
  if (
    options.apiKeyProvenance !== "DESKTOP_MANAGED" ||
    !options.signDesktopRequest
  ) {
    return undefined;
  }

  let reason = "sign_failed_or_null";
  try {
    const headers = await options.signDesktopRequest(options.request);
    if (headers) {
      return headers;
    }
  } catch (error) {
    reason = getDesktopPopUnavailableReason(error);
  }

  gatewayLog.warn("desktop-pop", options.unavailableMessage);
  options.onUnavailable?.(options.surface, reason);
  return undefined;
}
