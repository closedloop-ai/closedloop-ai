import { desktopAgentSessionsSyncApiResultValidator } from "@repo/api/src/types/agent-session";
import type { AgentSessionSyncTransportPayload } from "./agent-session-sync-contract.js";
import type { TraceCommentParentSessionSyncResult } from "./trace-comment-parent-session-cloud-sync.js";
import {
  buildTraceCommentParentSessionSyncPopHeaders,
  type TraceCommentParentSessionSyncPopOptions,
} from "./trace-comment-parent-session-sync-pop.js";

export type { TraceCommentParentSessionSyncResult } from "./trace-comment-parent-session-cloud-sync.js";

export type TraceCommentParentSessionSyncPostOptions =
  TraceCommentParentSessionSyncPopOptions & {
    getApiKey?: () => string | null;
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
  const apiKey = options.getApiKey?.();
  const apiOrigin = options.getApiOrigin?.();
  if (!(apiKey && apiOrigin)) {
    throw new Error("Desktop cloud session sync credentials unavailable.");
  }

  const url = new URL("/desktop/agent-sessions/sync", apiOrigin);
  url.searchParams.set("computeTargetId", computeTargetId);
  const popHeaders = await buildTraceCommentParentSessionSyncPopHeaders(
    options,
    url
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...popHeaders,
    },
    body: JSON.stringify(payload),
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
