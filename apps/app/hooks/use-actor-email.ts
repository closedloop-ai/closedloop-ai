"use client";

import { useUser } from "@repo/auth/client";

/** The signed-in viewer's email, and whether the identity has settled yet. */
export type ActorEmail = {
  readonly email: string | null;
  readonly isLoaded: boolean;
};

/**
 * The email every staff-visibility gate on this surface reads.
 *
 * ISS-10335: the two gates — `WebDevModeProvider`'s eligibility and
 * `StaffParsingBugFlagProvider` — each resolved it from Clerk's client
 * `useUser()`, which never hydrates on the Clerk-free lane, so both reported a
 * customer and the affordances they gate disappeared. The lane branch used to
 * be made here; it now lives in `@repo/auth/client`'s `useUser`, which answers
 * the whole synthetic user — settled, address included — whenever the
 * `local_trusted` identity is mounted. A second branch here would be the same
 * answer derived twice, free to drift from it.
 */
export function useActorEmail(): ActorEmail {
  const { user, isLoaded } = useUser();

  return {
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    isLoaded,
  };
}
