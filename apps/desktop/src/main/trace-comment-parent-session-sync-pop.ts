import type { ApiKeyProvenance } from "./api-key-store.js";
import type { DesktopPopSigner } from "./desktop-pop.js";
import {
  buildManagedDesktopPopHeaders,
  type DesktopPopUnavailableReporter,
} from "./desktop-pop-sign-utils.js";

export type TraceCommentParentSessionSyncPopOptions = {
  getApiKeyProvenance?: () => ApiKeyProvenance | null;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
};

/**
 * Builds the managed-key PoP headers for the targeted parent-session sync
 * fallback used by trace comment uploads after a 404.
 */
export async function buildTraceCommentParentSessionSyncPopHeaders(
  options: TraceCommentParentSessionSyncPopOptions,
  url: URL
): Promise<Record<string, string> | undefined> {
  return await buildManagedDesktopPopHeaders({
    apiKeyProvenance: options.getApiKeyProvenance?.() ?? "USER_CREATED",
    signDesktopRequest: options.signDesktopRequest,
    request: {
      method: "POST",
      pathname: url.pathname,
    },
    surface: "trace_comment_parent_session_sync",
    unavailableMessage:
      "Desktop PoP unavailable while syncing trace comment parent session",
    onUnavailable: options.onDesktopPopUnavailable,
  });
}
