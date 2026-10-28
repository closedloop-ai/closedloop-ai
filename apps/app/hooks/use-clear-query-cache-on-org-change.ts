"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Marks a cache that was used under some org and has since passed through a
 * window with no concrete org. Distinct from "absent" (never used) so the two
 * stay tellable apart: absent means nothing was ever cached and the next org
 * may keep what it finds, dirty means entries of unknown provenance may have
 * landed and the next org must not.
 */
const CACHE_DIRTY = Symbol("query-cache-dirty");

/**
 * Which org's data each QueryClient currently holds, keyed on the client so the
 * marker shares the CACHE's lifetime instead of a component's.
 *
 * ISS-7344: the browser QueryClient is a module-level singleton
 * (`apps/app/lib/query-client.tsx`) and clearing it on org change is the only
 * cross-org cache boundary in the app — nearly every query key is org-agnostic,
 * so a surviving org-A entry is a cache *hit* in org B and no request is ever
 * issued. Held in a component ref the marker was lost on remount, and the
 * remounted "first run" then recorded the new org without clearing. Keying on
 * the client makes a missed clear unreachable: the marker can only disappear
 * with the cache it describes.
 */
const cacheOwnerOrgId = new WeakMap<QueryClient, string | typeof CACHE_DIRTY>();

export function useClearQueryCacheOnOrgChange(orgId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    clearQueryCacheOnOrgChange(queryClient, orgId);
  }, [queryClient, orgId]);
}

function clearQueryCacheOnOrgChange(
  queryClient: QueryClient,
  orgId: string | undefined
): void {
  const previousOwner = cacheOwnerOrgId.get(queryClient);
  if (previousOwner === orgId) {
    return;
  }

  if (orgId === undefined) {
    enterUnresolvedOrgWindow(queryClient, previousOwner);
    return;
  }

  // A concrete org arriving. `previousOwner` is either another org's id or the
  // dirty mark; in both cases nothing here can be vouched for as this org's.
  // An unrecorded client is the only one that keeps what it holds — it has
  // never served another org, because a fresh page load builds a fresh
  // singleton.
  if (previousOwner !== undefined) {
    queryClient.clear();
  }
  cacheOwnerOrgId.set(queryClient, orgId);
}

/**
 * Clerk between orgs, or signed out. Clearing on the way in shrinks the window,
 * but it does not close it: the shell keeps rendering and any query it issues
 * refills the cache with entries this hook cannot attribute to an org. Marking
 * the client dirty — rather than deleting the marker, which would return it to
 * the "never used" state that deliberately skips clearing — is what makes the
 * next concrete org clear again and refuse to adopt them.
 */
function enterUnresolvedOrgWindow(
  queryClient: QueryClient,
  previousOwner: string | typeof CACHE_DIRTY | undefined
): void {
  if (previousOwner === undefined || previousOwner === CACHE_DIRTY) {
    return;
  }

  queryClient.clear();
  cacheOwnerOrgId.set(queryClient, CACHE_DIRTY);
}
