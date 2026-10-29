/**
 * ISS-10335 — the browser half of the synthetic session.
 *
 * Clerk's embeds require a provider at runtime, and this suite runs in the
 * `node` environment, so `@clerk/nextjs` is stubbed down to the one hook the
 * module under test imports. The fold is exported precisely so it can be
 * exercised here without a DOM; the React wiring around it (context → hook →
 * the `@repo/auth/client` shadowing) is pinned from `apps/app`, where the
 * production consumers and a jsdom environment already live.
 */

import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_TRUSTED_EMAIL_ADDRESS_ID,
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_EMAIL,
  LOCAL_TRUSTED_USER_FIRST_NAME,
  LOCAL_TRUSTED_USER_FULL_NAME,
  LOCAL_TRUSTED_USER_ID,
  LOCAL_TRUSTED_USER_LAST_NAME,
  LOCAL_TRUSTED_USERNAME,
  type LocalTrustedIdentity,
} from "../auth-mode";

vi.mock("@clerk/nextjs", () => ({
  useUser: () => {
    throw new Error("Clerk's hook must not run in this suite");
  },
}));

/** A lane-bound identity: NOT the fixed default, so an id the projection hard-coded would fail. */
const SEEDED_IDENTITY: LocalTrustedIdentity = {
  orgId: "org_seed_sandbox",
  orgSlug: "seed-sandbox",
  userId: "user_seed_sandbox",
};

// `as const` is load-bearing: Clerk's `UseUserReturn` is a union discriminated
// on literal `isLoaded`/`isSignedIn`, so a widened `boolean` matches no member.
const CLERK_SIGNED_OUT = {
  isLoaded: true,
  isSignedIn: false,
  user: null,
} as const;

const CLERK_LOADING = {
  isLoaded: false,
  isSignedIn: undefined,
  user: undefined,
} as const;

describe("resolveLocalTrustedUser", () => {
  it("returns Clerk's own result untouched on a real deployment", async () => {
    const { resolveLocalTrustedUser } = await import("../local-trusted-client");

    // Identity is the same OBJECT, not merely an equal one: production must not
    // pay a new allocation or a reshaped result for a lane it never enters.
    expect(resolveLocalTrustedUser(CLERK_SIGNED_OUT, null)).toBe(
      CLERK_SIGNED_OUT
    );
    expect(resolveLocalTrustedUser(CLERK_LOADING, null)).toBe(CLERK_LOADING);
  });

  it("reports a settled, signed-in synthetic user while Clerk is still loading", async () => {
    const { resolveLocalTrustedUser } = await import("../local-trusted-client");

    // `CLERK_LOADING` is the state the Clerk-free lane never leaves: there is no
    // session to hydrate. A wrapper that deferred to Clerk here would leave
    // every `user?.id` guard reading the viewer as signed out forever.
    const result = resolveLocalTrustedUser(CLERK_LOADING, SEEDED_IDENTITY);

    expect(result.isLoaded).toBe(true);
    expect(result.isSignedIn).toBe(true);
    expect(result.user?.id).toBe(SEEDED_IDENTITY.userId);
    expect(result.user?.id).not.toBe(LOCAL_TRUSTED_USER_ID);
  });

  it("carries the fields this repo's useUser consumers dereference", async () => {
    const { resolveLocalTrustedUser } = await import("../local-trusted-client");

    const user = resolveLocalTrustedUser(CLERK_LOADING, SEEDED_IDENTITY).user;

    expect(user?.primaryEmailAddress?.emailAddress).toBe(
      LOCAL_TRUSTED_USER_EMAIL
    );
    expect(user?.emailAddresses.at(0)?.emailAddress).toBe(
      LOCAL_TRUSTED_USER_EMAIL
    );
    expect(user?.primaryEmailAddressId).toBe(LOCAL_TRUSTED_EMAIL_ADDRESS_ID);
    expect(user?.firstName).toBe(LOCAL_TRUSTED_USER_FIRST_NAME);
    expect(user?.lastName).toBe(LOCAL_TRUSTED_USER_LAST_NAME);
    expect(user?.fullName).toBe(LOCAL_TRUSTED_USER_FULL_NAME);
    expect(user?.username).toBe(LOCAL_TRUSTED_USERNAME);
    // No avatar exists, and every consumer spells `user.imageUrl || null`, so
    // the empty string is the honest "none" rather than an invented URL.
    expect(user?.imageUrl).toBe("");
    expect(user?.externalAccounts).toEqual([]);
  });

  it("reports the same person the server's currentUser() does", async () => {
    // The two projections are separate because `local-trusted-session.ts` is
    // `server-only`. They agree by reading one set of constants, and this is
    // what fails if a literal is ever re-typed into either of them.
    const { resolveLocalTrustedUser } = await import("../local-trusted-client");
    const { buildLocalTrustedUser } = await import("../local-trusted-session");

    const defaultIdentity: LocalTrustedIdentity = {
      orgId: LOCAL_TRUSTED_ORG_ID,
      orgSlug: LOCAL_TRUSTED_ORG_SLUG,
      userId: LOCAL_TRUSTED_USER_ID,
    };
    const client = resolveLocalTrustedUser(CLERK_LOADING, defaultIdentity).user;
    const server = buildLocalTrustedUser();

    expect({
      firstName: client?.firstName,
      fullName: client?.fullName,
      hasImage: client?.hasImage,
      id: client?.id,
      imageUrl: client?.imageUrl,
      lastName: client?.lastName,
      primaryEmail: client?.emailAddresses.at(0)?.emailAddress,
      primaryEmailAddressId: client?.primaryEmailAddressId,
      username: client?.username,
    }).toEqual({
      firstName: server.firstName,
      fullName: server.fullName,
      hasImage: server.hasImage,
      id: server.id,
      imageUrl: server.imageUrl,
      lastName: server.lastName,
      primaryEmail: server.emailAddresses.at(0)?.emailAddress,
      primaryEmailAddressId: server.primaryEmailAddressId,
      username: server.username,
    });
  });

  it("shows the person a vibe stack names, keeping the synthetic id", async () => {
    // ISS-12135: `pnpm vibe up` names the seeded owner through the identity's
    // display overrides; the id stays the default the seed wrote her row under.
    const { resolveLocalTrustedUser } = await import("../local-trusted-client");

    const user = resolveLocalTrustedUser(CLERK_LOADING, {
      orgId: LOCAL_TRUSTED_ORG_ID,
      orgSlug: "acme-co",
      userId: LOCAL_TRUSTED_USER_ID,
      orgName: "Acme Co",
      userEmail: "maya.okafor@closedloop.ai",
      userFirstName: "Maya",
      userLastName: "Okafor",
    }).user;

    expect(user?.id).toBe(LOCAL_TRUSTED_USER_ID);
    expect(user?.primaryEmailAddress?.emailAddress).toBe(
      "maya.okafor@closedloop.ai"
    );
    expect(user?.firstName).toBe("Maya");
    expect(user?.lastName).toBe("Okafor");
    expect(user?.fullName).toBe("Maya Okafor");
  });
});
