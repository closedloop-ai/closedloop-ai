"use client";

import {
  postHogFeatureFlagsEnabled,
  useFeatureFlagsLoaded,
  usePostHogDistinctId,
} from "@repo/analytics/client";
import { useUser } from "@repo/auth/client";

/**
 * PostHog reflects the signed-in user once `identify()` has taken effect and
 * its distinct id matches the Clerk user id. A signed-out route has no user id;
 * treat a resolved (defined) distinct id as identified so signed-out gating is
 * not held open forever.
 */
export function isIdentifiedInPostHog(
  userId: string | undefined,
  distinctId: string | undefined
): boolean {
  if (distinctId === undefined) {
    return false;
  }
  if (userId === undefined) {
    return true;
  }
  return distinctId === userId;
}

/**
 * True once the flag values PostHog is serving describe the SIGNED-IN user
 * rather than the anonymous bootstrap — Clerk's user loaded, PostHog keyed on
 * that user's id (`identify()` landed), and its post-identify flag load
 * delivered.
 *
 * Until then a `false` is not a decision, only the answer for a distinct id the
 * user does not have yet, so nothing irreversible may be committed on it: not
 * `FeatureFlagRouteGate`'s `notFound()`, and not the Settings page bouncing a
 * `?tab=tags` deep link off a tab the identified user can actually see
 * (ISS-4566). One hook because three surfaces were composing the same three
 * signals by hand, and a fourth spelling of it is how the answers start to
 * differ.
 *
 * Its own module rather than `feature-flag-route-gate`, for the reason that
 * gate's own deadline constant is not in it either: the two non-gate callers
 * render no route gate, and importing it for this hook pulled `notFound`,
 * `FeatureFlagUnavailable`, `@repo/navigation/link` and `useOrgPath` into their
 * chunks. This module imports only the analytics and auth hooks it reads.
 */
export function useFeatureFlagsSettledForUser(): boolean {
  const { user, isLoaded: userLoaded } = useUser();
  const flagsLoaded = useFeatureFlagsLoaded();
  const distinctId = usePostHogDistinctId();

  // A build with no PostHog key resolves flags synchronously off the local
  // fixture: no anonymous bootstrap, no handshake to wait for — and no distinct
  // id, which the identity check below reads as "never settled" rather than
  // "already settled". Without this carve-out every such build (containerized
  // E2E, local dev) holds its gated surfaces open until the bounded deadline
  // instead of honoring a flag that was decided from the first render.
  if (!postHogFeatureFlagsEnabled) {
    return true;
  }

  return (
    userLoaded && flagsLoaded && isIdentifiedInPostHog(user?.id, distinctId)
  );
}
