import type { User } from "@repo/api/src/types/user";
import {
  getInitials,
  transformApiUserToSelectUser,
} from "../../shared/lib/user-utils";
import type {
  OnboardingMemberPreview,
  OnboardingOrganizationMembers,
} from "../components/guided-onboarding-data";

/** How many teammates the invite step names before it summarises the rest. */
export const ONBOARDING_MEMBER_PREVIEW_LIMIT = 3;

/**
 * The roster read's settled shape, independent of TanStack's field names so the
 * fold stays a pure function the hook adapts onto.
 */
export type OnboardingRosterRead =
  | { status: "unresolved" }
  | { status: "resolved"; users: readonly User[] };

/**
 * Collapse the organization roster into the invite step's social-proof claim.
 *
 * Three distinctions this deliberately keeps apart, because the step renders a
 * different sentence for each and two of them look identical after counting:
 *
 * - **Unresolved** — errored, disabled, or still in flight. Nothing is claimed.
 * - **Resolved but EMPTY** — also `unknown`. An empty `/users` establishes
 *   nothing: a viewer scoped to no rows and a signer whose own `User` row has
 *   not been synced by the Clerk membership webhook yet both land here, and
 *   neither entitles the step to say "you are the first person from your
 *   company". `activity-directory.ts` classifies the same read the same way and
 *   records why (ISS-5007).
 * - **Resolved to exactly the signer** — `known` with a count of 0. THIS is the
 *   genuine first-person-in case, and it is the only input that may render it.
 *
 * The signer is excluded from both the count and the preview. `/users` has no
 * self-filter, so without this a solo founder is told "1 people at your company
 * already use Closedloop" above a chip bearing their own name. An UNKNOWN
 * signer is therefore also `unknown`: without an identity to subtract, a roster
 * of one cannot be told apart from a team of one, and guessing picks the
 * flattering answer.
 */
export function foldOnboardingOrganizationMembers(
  read: OnboardingRosterRead,
  currentUserId: string | null
): OnboardingOrganizationMembers {
  if (read.status === "unresolved") {
    return { status: "unknown" };
  }
  if (read.users.length === 0 || currentUserId === null) {
    return { status: "unknown" };
  }
  const others = read.users.filter((user) => user.id !== currentUserId);

  return {
    status: "known",
    count: others.length,
    preview: toPreview(others),
  };
}

/**
 * Longest-tenured teammates first. The API orders `createdAt: desc`, so taking
 * its head would name the three NEWEST accounts — the people a new joiner is
 * least likely to recognise — as the proof their team is already here. Sorted
 * here rather than assumed from the server's direction, so a change there
 * cannot silently invert the meaning.
 */
function toPreview(users: readonly User[]): readonly OnboardingMemberPreview[] {
  return [...users]
    .sort(byOldestFirst)
    .slice(0, ONBOARDING_MEMBER_PREVIEW_LIMIT)
    .map((user) => {
      const { id, name, initials, avatarUrl } =
        transformApiUserToSelectUser(user);
      return {
        id,
        avatarUrl,
        name,
        // `getUserInitials` returns "" when neither name part is set, which
        // renders an empty avatar circle beside a real person. Fall back to the
        // display name the row is actually labelled with.
        initials: initials || getInitials(name),
      };
    });
}

function byOldestFirst(a: User, b: User): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}
