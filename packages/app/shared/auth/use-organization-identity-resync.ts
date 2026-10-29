"use client";

import { useAuthAdapter } from "./provider";

/**
 * Resynchronize the shell after the active organization's identity changed.
 * Resolves through the injected auth port, so `@repo/app` stays free of the
 * auth SDK and of web-URL knowledge — see
 * {@link import("./auth-adapter").AuthAdapter.useOrganizationIdentityResync}
 * for what a shell owes this contract.
 *
 * A shell that does not implement it gets a resolving no-op, which is the
 * correct reading of "this surface has no URL-visible organization to
 * re-anchor" — never a failure, because the caller's mutation has already
 * committed.
 */
export function useOrganizationIdentityResync(): (
  nextOrgSlug: string
) => Promise<void> {
  const adapter = useAuthAdapter();
  // Selected first, then called unconditionally: the adapter identity is stable
  // for the life of a mounted tree, so hook order never varies between a shell
  // that implements this member and one that does not. Same shape as
  // `useFeatureFlagResolved` in `shared/feature-flags`.
  const useResync = adapter.useOrganizationIdentityResync ?? useNoResync;
  return useResync();
}

function noResync(): Promise<void> {
  return Promise.resolve();
}

function useNoResync(): (nextOrgSlug: string) => Promise<void> {
  return noResync;
}
