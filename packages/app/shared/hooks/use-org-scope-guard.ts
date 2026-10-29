"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useOptionalAuthSnapshot } from "../auth/use-auth-snapshot";

/**
 * The org-switch interlock every optimistic artifact write needs, stated once.
 *
 * `packages/app/AGENTS.md`: "Capture the org scope before the first `await` in
 * `onMutate` and recheck it after: the org can switch while `cancelQueries` is
 * pending, and the callback then writes org A's rows under org B's key."
 *
 * The Sessions cache keys carry the active DATA SOURCE as their `scope`
 * segment, not an org — so nothing in the key space separates one org's rows
 * from another's, and the web shell clearing the `QueryClient` on an org change
 * does not stop a mutation already in flight from writing its snapshot back
 * afterwards (whitlockk review, PR #8315). This is what closes that: a write whose
 * org is no longer current touches no cache.
 *
 * `useOptionalAuthSnapshot`, not `useAuthSnapshot`, because the engines that
 * read this are shared and mount in contexts with no auth provider (a bare
 * table render, Storybook). There `orgId` is a stable `null`, every capture
 * matches, and the guard allows every write — exactly the behavior that shipped
 * before it existed.
 */
export function useOrgScopeGuard(): OrgScopeGuard {
  const { orgId } = useOptionalAuthSnapshot();
  // A LAYOUT effect, so the mirror is current before the browser paints the
  // switched org: a passive effect can flush after an in-flight `onMutate`
  // resumes, and the guard would then compare against the org that is leaving.
  const liveOrgIdRef = useRef(orgId);
  useLayoutEffect(() => {
    liveOrgIdRef.current = orgId;
  }, [orgId]);
  // Stable across renders, so a caller may hold it in a dependency array; the
  // live value is read through the ref rather than closed over.
  return useMemo(
    () => ({
      capture: () => liveOrgIdRef.current,
      isStillCurrent: (captured: string | null) =>
        liveOrgIdRef.current === captured,
    }),
    []
  );
}

export type OrgScopeGuard = Readonly<{
  /** The org a write belongs to. Call BEFORE the first `await` in `onMutate`. */
  capture: () => string | null;
  /** Whether that org is still the active one. False means: write nothing. */
  isStillCurrent: (captured: string | null) => boolean;
}>;
