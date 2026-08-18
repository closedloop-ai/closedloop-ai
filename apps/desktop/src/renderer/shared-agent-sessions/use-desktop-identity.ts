import { useEffect, useState } from "react";
import type { DesktopAuthStatus, DesktopIdentity } from "../types/desktop-api";

/**
 * The result of resolving the display-only identity: the payload, plus whether
 * that answer is SETTLED.
 *
 * ISS-5366 review: the two are not the same question, and collapsing them to a
 * bare `DesktopIdentity | null` is what let a consumer read "still loading" as
 * "definitively unavailable". `identity: null` with `isResolved: false` means
 * "not known YET"; `identity: null` with `isResolved: true` means "there is no
 * identity" (signed out, no bridge, or a failed fetch). A caller that gates a
 * navigable affordance on the identity has to be able to tell those apart, or it
 * renders its unavailable state during the load window and asserts something
 * false about data that is on its way.
 */
export type DesktopIdentityResolution = Readonly<{
  identity: DesktopIdentity | null;
  isResolved: boolean;
}>;

/**
 * Settled identities, keyed by the authenticated user id.
 *
 * Every mount used to run its own `GET /desktop/identity` (one IPC round trip
 * per hook INSTANCE — the Sidebar's AccountMenu, the Settings Account tab and
 * every session-detail mount each paid for their own), and every one of them
 * started from `null` and flipped once it landed. Caching the settled payload
 * here means a mount that happens after any earlier resolution seeds its state
 * SYNCHRONOUSLY on first render, so there is no window in which it reports a
 * false `null` at all.
 */
const settledIdentities = new Map<string, DesktopIdentity | null>();

/** In-flight fetches, keyed the same way, so concurrent mounts share one IPC. */
const inFlightIdentities = new Map<string, Promise<DesktopIdentity | null>>();

function fetchIdentityOnce(
  authedUserId: string
): Promise<DesktopIdentity | null> {
  const existing = inFlightIdentities.get(authedUserId);
  if (existing) {
    return existing;
  }
  const fetchIdentity = window.desktopApi?.getDesktopIdentity;
  if (!fetchIdentity) {
    // No bridge (a partial test stub, or a renderer mounted outside Electron).
    // This is SETTLED, not pending: it will never resolve, and reporting it as
    // pending forever would strand callers in their loading state.
    settledIdentities.set(authedUserId, null);
    return Promise.resolve(null);
  }
  const pending = fetchIdentity()
    .then((result) => {
      settledIdentities.set(authedUserId, result);
      return result;
    })
    .catch(() => {
      // A failed fetch is a settled "no identity", same as before.
      settledIdentities.set(authedUserId, null);
      return null;
    })
    .finally(() => {
      inFlightIdentities.delete(authedUserId);
    });
  inFlightIdentities.set(authedUserId, pending);
  return pending;
}

/**
 * Test seam: drop the process-wide caches so one test's resolved identity does
 * not leak into the next test's first render.
 */
export function resetDesktopIdentityCacheForTests(): void {
  settledIdentities.clear();
  inFlightIdentities.clear();
}

/**
 * Resolve the display-only identity (name, email, organization name/slug) once
 * signed in. A null result (fetch/transport failure, signed-out, or a
 * bridge-absent test stub) leaves callers to fall back to their id/label so a
 * consuming surface is never blanked.
 *
 * Shared by the Settings → Account tab, the sidebar footer AccountMenu and the
 * session-detail view so they read one identity source rather than duplicating
 * the fetch effect — and, as of ISS-5366, one identity FETCH: the payload is
 * cached per user id and concurrent mounts share a single in-flight request.
 *
 * The cache is stale-while-revalidate rather than write-once: a cached payload
 * seeds the first render, and the mount still revalidates behind it, so an org
 * rename or an org switch made elsewhere is picked up on the next mount instead
 * of being pinned for the life of the process.
 */
export function useDesktopIdentity(
  status: DesktopAuthStatus,
  userId: string | null
): DesktopIdentityResolution {
  const authedUserId = status === "authenticated" ? userId : null;
  const [resolution, setResolution] = useState<DesktopIdentityResolution>(() =>
    initialIdentityResolution(authedUserId)
  );

  useEffect(() => {
    if (!authedUserId) {
      // Signed out is a SETTLED absence, not a pending one: there is no fetch
      // to wait for, so a caller must not hold a loading state here.
      setResolution({ identity: null, isResolved: true });
      return;
    }
    let cancelled = false;
    // Seed synchronously from cache when we have it, so a remount after any
    // earlier resolution never renders a transient `null`.
    setResolution(initialIdentityResolution(authedUserId));
    fetchIdentityOnce(authedUserId)
      .then((identity) => {
        if (!cancelled) {
          setResolution({ identity, isResolved: true });
        }
      })
      // `fetchIdentityOnce` settles its own fetch failures to `null`, so this
      // arm is unreachable in practice. It is still the honest handler: a
      // rejection that somehow escaped would leave the resolution PENDING
      // forever, and a caller waiting on `isResolved` would hold its loading
      // state for the life of the view.
      .catch(() => {
        if (!cancelled) {
          setResolution({ identity: null, isResolved: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authedUserId]);

  return resolution;
}

function initialIdentityResolution(
  authedUserId: string | null
): DesktopIdentityResolution {
  if (!authedUserId) {
    return { identity: null, isResolved: true };
  }
  if (settledIdentities.has(authedUserId)) {
    return {
      identity: settledIdentities.get(authedUserId) ?? null,
      isResolved: true,
    };
  }
  return { identity: null, isResolved: false };
}
