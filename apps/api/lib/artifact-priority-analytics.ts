import "server-only";

import { analytics } from "@repo/analytics/server";
import type { Priority } from "@repo/api/src/types/common";
import type {
  ArtifactPriorityCommitResult,
  ArtifactPriorityEditSurface,
} from "@repo/api/src/types/priority-contract";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";

/**
 * Product analytics for priority commits (ISS-9443).
 *
 * The activity receipt `artifact-activity-capture.ts` already writes is the
 * per-artifact audit trail; this is the aggregate half, how often each SURFACE
 * is used to move a priority, which is the question the activity table cannot
 * answer without scanning it. It is the priority sibling of the status emit
 * ISS-9436 added, and holds the same three properties:
 *
 * 1. ONE event per COMMIT, never one per artifact. A bulk priority change can
 *    touch hundreds of rows; a per-row capture would be an unbounded fan-out of
 *    network calls off a single request (`apps/api/AGENTS.md`, bounded
 *    fan-out) and would drown the surface signal in row count. `artifactCount`
 *    carries the size instead.
 * 2. NO artifact content. The properties are the surface, the result, the two
 *    priority values and a count, nothing a reader could not already see on
 *    the priority picker itself.
 * 3. Best-effort and off the response path. Scheduled through `waitUntil` and
 *    wrapped, so a PostHog outage can neither delay nor fail the write the user
 *    just made.
 */

/** The PostHog event name. A wire value: renaming it orphans every dashboard. */
export const ARTIFACT_PRIORITY_CHANGED_EVENT = "artifact_priority_changed";

export type ArtifactPriorityChangeAnalyticsInput = {
  organizationId: string;
  /** The platform user id, used as the PostHog distinct id. */
  userId: string;
  surface: ArtifactPriorityEditSurface;
  result: ArtifactPriorityCommitResult;
  /**
   * The priority left behind, and THREE states rather than two. A member is the
   * prior value; `null` says the artifact held none; OMITTED says this commit
   * has no single prior to name, a bulk commit spans as many priors as it has
   * rows. The distinction is load-bearing because `null` is a real domain value
   * here, so spending it as a "mixed" sentinel would report every bulk commit
   * as having moved unprioritized artifacts, which is a measurement nobody made
   * (ISS-9443 review, codex).
   */
  from?: Priority | null;
  /**
   * The priority written. `null` is a real target here and not an absent one:
   * ISS-9665 made clearing a priority a first-class write, so "set to nothing"
   * is a transition this event must be able to describe. That is the one shape
   * difference from the status event, where a write TARGET is always a value.
   */
  to: Priority | null;
  /** Artifacts this one commit moved. 1 for a single-row write. */
  artifactCount: number;
};

/**
 * Capture one priority-commit analytics event, best-effort and non-blocking.
 *
 * Callers pass a surface or capture nothing: the whole point of the event is
 * which surface was used, and an event attributed to a surface we guessed is
 * worse than no event, it would move a real number onto a bar nobody clicked.
 * That is why `surface` is required here while it stays optional on the request
 * body, where an API-key or MCP write legitimately names none.
 */
export function captureArtifactPriorityChangeAnalytics(
  input: ArtifactPriorityChangeAnalyticsInput
): void {
  waitUntil(emitArtifactPriorityChangeAnalytics(input));
}

/**
 * {@link captureArtifactPriorityChangeAnalytics}'s awaitable half. Never
 * rejects: a capture failure is logged through the server logger and swallowed,
 * so the caller's write is untouched.
 */
async function emitArtifactPriorityChangeAnalytics(
  input: ArtifactPriorityChangeAnalyticsInput
): Promise<void> {
  try {
    await analytics.captureImmediate({
      distinctId: input.userId,
      event: ARTIFACT_PRIORITY_CHANGED_EVENT,
      properties: {
        organizationId: input.organizationId,
        surface: input.surface,
        result: input.result,
        // Omission PRESERVED, never serialized as `null`: the property is
        // absent when the commit had no single prior, and `null` is reserved
        // for the one thing it already means, the artifact held no priority.
        ...(input.from === undefined ? {} : { from: input.from }),
        to: input.to,
        artifactCount: input.artifactCount,
      },
    });
  } catch (error) {
    log.error("Failed to capture artifact priority change analytics", {
      organizationId: input.organizationId,
      surface: input.surface,
      error: parseError(error),
    });
  }
}
