"use client";

import { useQueryClient } from "@tanstack/react-query";
import { setQueryCacheScope } from "./query-client";

/**
 * The cache-identity string every query on a shell's `QueryClient` is scoped by
 * (ISS-7442). Both halves matter and for different reasons: the organization
 * because nearly every read is org-scoped server-side, and the user because a
 * caller-scoped read (`/onboarding`'s dismissal, `/users/current`) would
 * otherwise answer for the next account signed in to the same tab.
 *
 * `null` means "no identity resolved", which the client turns into a fresh
 * single-use anonymous identity rather than leaving the cache unscoped — see
 * `setQueryCacheScope`. That distinction is load-bearing: a query mounted
 * before the shell's identity hydrates still resolves with REAL data, because
 * `useApiClient` awaits auth inside the request rather than gating the query,
 * so a shared anonymous slot would hand one identity's rows to the next.
 */
export function queryCacheScopeOf(
  userId: string | null | undefined,
  organizationId: string | null | undefined
): string | null {
  if (!userId) {
    return null;
  }
  return JSON.stringify([userId, organizationId ?? null]);
}

/**
 * Bind the surrounding `QueryClient`'s cache identity to `scope`, DURING RENDER.
 *
 * The render phase is load-bearing, not incidental. The shell's
 * clear-on-organization-change effect can only run after commit, so between an
 * identity flip and that effect there is a render in which components mounting
 * for the new organization read the cache —
 * the "beat later" window `use-onboarding.ts` documents (ISS-5991). Setting the
 * scope here means those components already hash against the new identity and
 * miss, so the window has nothing left to leak. An effect here would reintroduce
 * exactly the race it exists to remove.
 *
 * Call it from a component that renders ABOVE every query on that client, so the
 * new scope is in place before any child reads.
 */
export function useQueryCacheScope(scope: string | null): void {
  setQueryCacheScope(useQueryClient(), scope);
}
