import { desktopAgentSessionsSyncApiResultValidator } from "@repo/api/src/types/agent-session-sync-api-result";
import type { AgentSessionSyncTransportPayload } from "../agent-sync/agent-session-sync-contract.js";
import { resolveDesktopCloudCredential } from "../auth/desktop-cloud-credential.js";
import type { TraceCommentParentSessionSyncResult } from "./trace-comment-parent-session-cloud-sync.js";

export type { TraceCommentParentSessionSyncResult } from "./trace-comment-parent-session-cloud-sync.js";

// Bound the parent-session sync POST so a hung dependency cannot stall the
// pending-comment sync retry loop indefinitely; matches the transcript-sync
// client convention.
const PARENT_SESSION_SYNC_REQUEST_TIMEOUT_MS = 30_000;

export type TraceCommentParentSessionSyncPostOptions = {
  /**
   * FEA-3425 (Phase 4a): first-party Desktop session token — the only
   * credential. The static `sk_live_*` key (+PoP) fallback was removed once
   * session coverage cleared the D7 no-strand gate.
   */
  getAccessToken?: () => Promise<string | null>;
  getApiOrigin?: () => string;
  log?: (scope: string, message: string) => void;
};

/**
 * Posts one prepared parent-session sync payload through the direct desktop
 * sync route used when cloud trace comments need the referenced session first.
 */
export async function postTraceCommentParentSessionCloudSync(
  sessionId: string,
  payload: AgentSessionSyncTransportPayload,
  options: TraceCommentParentSessionSyncPostOptions,
  computeTargetId: string
): Promise<TraceCommentParentSessionSyncResult> {
  const apiOrigin = options.getApiOrigin?.();
  if (!apiOrigin) {
    throw new Error("Desktop cloud session sync credentials unavailable.");
  }

  const url = new URL("/desktop/agent-sessions/sync", apiOrigin);
  url.searchParams.set("computeTargetId", computeTargetId);

  // FEA-3425 (Phase 4a): session-only. The static-key (+PoP) fallback was
  // removed once session coverage cleared the D7 no-strand gate; the session
  // Bearer is the only credential — parity with the transcript/component lanes.
  const credential = await resolveDesktopCloudCredential(options);
  if (!credential) {
    throw new Error("Desktop cloud session sync credentials unavailable.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PARENT_SESSION_SYNC_REQUEST_TIMEOUT_MS),
  });
  const responseJson = await response.json().catch(() => null);
  const parsedResponse =
    desktopAgentSessionsSyncApiResultValidator.safeParse(responseJson);
  if (
    !(
      response.ok &&
      parsedResponse.success &&
      parsedResponse.data.success === true
    )
  ) {
    throw new Error(
      parsedResponse.success && parsedResponse.data.success === false
        ? parsedResponse.data.error
        : `Agent session sync request failed with status ${response.status}.`
    );
  }
  options.log?.("trace-comments", `Synced parent session for ${sessionId}`);
  return parsedResponse.data.data;
}
