import "server-only";

import { analytics } from "@repo/analytics/server";
import type { ArtifactStatusCommitResult } from "@repo/api/src/types/artifact-activity";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";

/**
 * Product analytics for status commits (ISS-9436).
 *
 * The activity receipt is the per-artifact audit trail; this is the aggregate
 * half, how often each SURFACE is used to move a status, which is the question
 * the activity table cannot answer without scanning it.
 *
 * Three properties of this module are load-bearing:
 *
 * 1. ONE event per COMMIT, never one per artifact. A bulk status change can
 *    touch hundreds of rows; a per-row capture would be an unbounded fan-out of
 *    network calls off a single request (`apps/api/AGENTS.md`, bounded
 *    fan-out) and would drown the surface signal in row count. `artifactCount`
 *    carries the size instead.
 * 2. NO artifact content. The properties are the surface, the result, the two
 *    status values and a count, no title, no body, no assignee, nothing a
 *    reader could not already see on the status picker itself.
 * 3. Best-effort and off the response path, like every other emit beside it.
 *    Scheduled through `waitUntil` and wrapped, so a PostHog outage can neither
 *    delay nor fail the write the user just made. `captureImmediate` is what
 *    makes that true rather than merely stated: `capture()` returns `void` and
 *    only QUEUES the send, so awaiting it resolves at once, `waitUntil` gets a
 *    promise that is already done, and a serverless function is free to freeze
 *    with the event still undelivered, and any delivery failure lands outside
 *    the `catch` below. `captureImmediate` returns the promise for the actual
 *    send, so the function stays alive for it and a failure reaches the logger.
 */

/** The PostHog event name. A wire value: renaming it orphans every dashboard. */
export const ARTIFACT_STATUS_CHANGED_EVENT = "artifact_status_changed";

export type ArtifactStatusChangeAnalyticsInput = {
  organizationId: string;
  /** The platform user id, used as the PostHog distinct id. */
  userId: string;
  surface: ArtifactStatusEditSurface;
  result: ArtifactStatusCommitResult;
  /**
   * The status left behind, in three distinct states, the key is REQUIRED so
   * every caller has to say which one it means:
   *
   * - a string, every artifact this commit moved held that status.
   * - `null`  , the artifact held NO status. A real measurement.
   * - `undefined`, the rows this commit moved disagreed, so there is no single
   *   origin to name. The property is then OMITTED from the event rather than
   *   sent as `null`, because `null` already claims something specific and a
   *   mixed commit reported as "absent status → target" would corrupt every
   *   funnel and transition analysis built on this event.
   */
  from: string | null | undefined;
  to: string;
  /** Artifacts this one commit moved. 1 for a single-row write. */
  artifactCount: number;
};

/**
 * Capture one status-commit analytics event, best-effort and non-blocking.
 *
 * A no-op when the caller could not name a surface: the whole point of the
 * event is which surface was used, and an event attributed to a surface we
 * guessed is worse than no event, it would move a real number onto a bar
 * nobody clicked. Callers therefore pass a surface or get nothing captured,
 * which is why `surface` is required here while it is optional on the receipt.
 */
export function captureArtifactStatusChangeAnalytics(
  input: ArtifactStatusChangeAnalyticsInput
): void {
  waitUntil(emitArtifactStatusChangeAnalytics(input));
}

/**
 * {@link captureArtifactStatusChangeAnalytics}'s awaitable half. Never rejects:
 * a capture failure is logged through the server logger and swallowed, so the
 * caller's write is untouched.
 */
async function emitArtifactStatusChangeAnalytics(
  input: ArtifactStatusChangeAnalyticsInput
): Promise<void> {
  try {
    await analytics.captureImmediate({
      distinctId: input.userId,
      event: ARTIFACT_STATUS_CHANGED_EVENT,
      properties: {
        organizationId: input.organizationId,
        surface: input.surface,
        result: input.result,
        // Omitted, never nulled, when the commit had no single origin, see
        // `from` on the input type.
        ...(input.from === undefined ? {} : { from: input.from }),
        to: input.to,
        artifactCount: input.artifactCount,
      },
    });
  } catch (error) {
    log.error("Failed to capture artifact status change analytics", {
      organizationId: input.organizationId,
      surface: input.surface,
      error: parseError(error),
    });
  }
}
