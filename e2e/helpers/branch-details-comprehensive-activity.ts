/**
 * ISS-10980: the Branch Activity feed page both shells' Branch-detail e2e
 * fixtures serve from `GET /branches/[id]/activity`.
 *
 * One stored edit plus one comment, so the tab's two row kinds are both
 * exercised over the REAL wire shape — `createdAt` crosses as an ISO string
 * where every unit fixture hands the mapper a `Date`, and the comment's
 * surface decides which tab its row addresses.
 *
 * Its own module rather than another block in
 * `branch-details-comprehensive-comments-trace.ts`, which is already past the
 * 500-line smell (root `AGENTS.md` -> File Size and Organization), and shared
 * rather than copied per shell: the web fixture and the desktop stand-in must
 * serve the same page or the two specs assert different feeds.
 */

import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedResult,
} from "@repo/api/src/types/artifact-activity-feed";
import { CommentSurface } from "@repo/api/src/types/comment";

/** The thread the Activity tab's comment row addresses. */
export const BRANCH_ACTIVITY_THREAD_ID = "00000000-0000-7000-8000-0000000000aa";

/**
 * The surface that thread records. `branch_timeline` on purpose: it routes the
 * comment row to the Sessions tab, which is NOT the fallback the Branch host
 * uses for a surface it cannot state, so a spec asserting the tab fails if the
 * surface stops being read (ISS-10980).
 */
export const BRANCH_ACTIVITY_THREAD_SURFACE = CommentSurface.BranchTimeline;

/** The actor both rows are attributed to. */
const BRANCH_ACTIVITY_ACTOR_ID = "11111111-1111-4111-8111-1111111111aa";

export function branchActivityPage(): ArtifactActivityFeedResult {
  return {
    items: [
      {
        action: null,
        actor: {
          id: BRANCH_ACTIVITY_ACTOR_ID,
          kind: ActivityFeedActorKind.Human,
        },
        after: null,
        before: null,
        createdAt: new Date("2026-10-02T12:00:00.000Z"),
        id: `comment:${BRANCH_ACTIVITY_THREAD_ID}`,
        payload: {
          surface: BRANCH_ACTIVITY_THREAD_SURFACE,
          threadId: BRANCH_ACTIVITY_THREAD_ID,
        },
        source: ActivityFeedItemSource.Comment,
      },
      {
        action: ArtifactActivityAction.FieldChange,
        actor: {
          id: BRANCH_ACTIVITY_ACTOR_ID,
          kind: ActivityFeedActorKind.Human,
        },
        after: { name: "feature/branches-detail" },
        before: { name: "feature/branches" },
        createdAt: new Date("2026-10-01T12:00:00.000Z"),
        id: "event:11111111-1111-4111-8111-111111111111",
        payload: null,
        source: ActivityFeedItemSource.Event,
      },
    ],
    nextCursor: null,
  };
}
