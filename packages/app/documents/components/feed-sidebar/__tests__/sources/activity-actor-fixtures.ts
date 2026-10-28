/**
 * Shared actor-row fixtures for the `ActivityActor` suites.
 *
 * Extracted because the same person, the same three actors, and the same
 * settled-directory helper were being re-declared per suite, and a second
 * suite (ISS-5955) made that a third copy in one directory. Two copies of one
 * fixture drift silently: a test tuned against a `DANA` whose name differs by a
 * character from its neighbour's proves nothing about the neighbour.
 *
 * Not a `*.test.ts` file, so vitest's default `include` never collects it.
 *
 * The `vi.mock` calls deliberately stay inline in each suite. A mock factory is
 * hoisted above the imports, so routing it through this module would buy three
 * shared lines at the cost of a hoisting footgun — and the factories are not
 * what was drifting.
 */
import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
} from "@repo/api/src/types/artifact-activity-feed";
import type { User } from "@repo/api/src/types/user";
import {
  type ActivityDirectory,
  ActivityDirectoryStatus,
} from "../../sources/activity-types";

/** The rendered name — asserted on, so it is derived from nothing. */
export const DANA_NAME = "Dana Reed";

/**
 * An inline data URI rather than a remote URL: it resolves identically offline
 * and in CI.
 *
 * What it shares with the e2e fixture and the story is the
 * `data:image/svg+xml` PREFIX, and that is the whole of it — the payloads
 * already differ, those two drawing a filled rect where this one is an empty
 * SVG. No guard makes the three agree and none is claimed here. The prefix is
 * the only part anything actually reads: `document-activity-actor-kind.spec.ts`
 * locates the photo with `img[src^='data:image/svg+xml']`, and nothing in this
 * suite inspects the bytes at all.
 */
export const DANA_AVATAR_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3C/svg%3E";

export const DANA: User = {
  id: "user_b",
  firstName: "Dana",
  lastName: "Reed",
  email: "dana@example.com",
} as User;

/** The same person, with a profile photo — the most common real row. */
export const DANA_WITH_PHOTO: User = {
  ...DANA,
  avatarUrl: DANA_AVATAR_URL,
} as User;

export const AGENT_ACTOR: ActivityFeedActor = {
  kind: ActivityFeedActorKind.Agent,
  id: "agent-1",
};

export const SYSTEM_ACTOR: ActivityFeedActor = {
  kind: ActivityFeedActorKind.System,
  id: null,
};

export const HUMAN_ACTOR: ActivityFeedActor = {
  kind: ActivityFeedActorKind.Human,
  id: DANA.id,
};

/**
 * A settled directory holding exactly `record`. Takes the record rather than
 * closing over {@link DANA} so a suite can settle the photo-bearing variant
 * without a second helper.
 */
export function readyDirectory(record: User): ActivityDirectory<User> {
  return {
    status: ActivityDirectoryStatus.Ready,
    find: (id) => (id === record.id ? record : null),
  };
}
