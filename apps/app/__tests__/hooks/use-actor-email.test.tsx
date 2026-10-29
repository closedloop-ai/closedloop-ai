/**
 * ISS-10335 — `useActorEmail`, the one read site both staff-visibility gates use.
 *
 * Clerk is mocked at `@clerk/nextjs`, NOT at `@repo/auth/client`, so the whole
 * production chain runs: the `local_trusted` context, the `useUser` wrapper
 * that reads it, and the shadowing that makes `@repo/auth/client` hand back
 * that wrapper instead of Clerk's bare hook. Mocking the barrel would replace
 * the very seam under test.
 *
 * The Clerk fixture answers a DIFFERENT, non-staff email in every case, which
 * is what makes the pair falsifiable: a synthetic path that fell through would
 * return that address and fail naming it, and a lane path that short-circuited
 * a real deployment would return the synthetic one.
 */

import type { LocalTrustedIdentity } from "@repo/auth/auth-mode";
import { LOCAL_TRUSTED_USER_EMAIL } from "@repo/auth/auth-mode";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useActorEmail } from "@/hooks/use-actor-email";

const mockUseClerkUser = vi.fn();
vi.mock("@clerk/nextjs", () => ({
  useUser: () => mockUseClerkUser(),
}));

const CLERK_EMAIL = "dana@acme-corp.com";
const SYNTHETIC_IDENTITY: LocalTrustedIdentity = {
  orgId: "org_seed_sandbox",
  orgSlug: "seed-sandbox",
  userId: "user_seed_sandbox",
};

afterEach(() => {
  cleanup();
  mockUseClerkUser.mockReset();
});

describe("useActorEmail", () => {
  it("answers the synthetic address, settled, when the local_trusted identity is present", () => {
    // Clerk is still loading here, which is the state the Clerk-free lane never
    // leaves: a hook that waited on it would report the viewer as unsettled
    // forever and both gated affordances would stay hidden.
    expect(renderActorEmail({ isLoaded: false }, SYNTHETIC_IDENTITY)).toEqual({
      email: LOCAL_TRUSTED_USER_EMAIL,
      isLoaded: true,
    });
  });

  it("answers Clerk's address on a real deployment", () => {
    expect(renderActorEmail({ isLoaded: true, email: CLERK_EMAIL })).toEqual({
      email: CLERK_EMAIL,
      isLoaded: true,
    });
  });

  it("reports a signed-out Clerk viewer as having no address", () => {
    expect(renderActorEmail({ isLoaded: true })).toEqual({
      email: null,
      isLoaded: true,
    });
  });
});

function Probe() {
  const { email, isLoaded } = useActorEmail();
  return (
    <output data-testid="actor">{JSON.stringify({ email, isLoaded })}</output>
  );
}

function renderActorEmail(
  clerk: { isLoaded: boolean; email?: string },
  identity: LocalTrustedIdentity | null = null
): { email: string | null; isLoaded: boolean } {
  mockUseClerkUser.mockReturnValue({
    isLoaded: clerk.isLoaded,
    isSignedIn: clerk.isLoaded ? Boolean(clerk.email) : undefined,
    user: clerk.email
      ? { primaryEmailAddress: { emailAddress: clerk.email } }
      : null,
  });
  render(
    <LocalTrustedIdentityProvider identity={identity}>
      <Probe />
    </LocalTrustedIdentityProvider>
  );
  return JSON.parse(screen.getByTestId("actor").textContent ?? "");
}
