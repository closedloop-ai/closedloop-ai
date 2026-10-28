import { LOCAL_TRUSTED_CLIENT_TOKEN } from "@repo/api/src/types/local-trusted-auth";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_NAME_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_EMAIL_ENV,
  E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
  E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV,
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_SESSION_ID,
  LOCAL_TRUSTED_USER_ID,
} from "../auth-mode";
import {
  buildLocalTrustedAuth,
  buildLocalTrustedUser,
} from "../local-trusted-session";

// FEA-4334: the synthetic identity must be fixed and obviously fake — never a
// real user/org. These assert the exact synthetic ids and an active,
// signed-in-shaped auth object the authenticated layout can render against.

describe("buildLocalTrustedAuth", () => {
  it("returns the fixed synthetic signed-in identity + active org", () => {
    const auth = buildLocalTrustedAuth();

    expect(auth.userId).toBe(LOCAL_TRUSTED_USER_ID);
    expect(auth.orgId).toBe(LOCAL_TRUSTED_ORG_ID);
    expect(auth.orgSlug).toBe(LOCAL_TRUSTED_ORG_SLUG);
    expect(auth.orgRole).toBe(LOCAL_TRUSTED_ORG_ROLE);
    expect(auth.sessionId).toBe(LOCAL_TRUSTED_SESSION_ID);
    expect(auth.isAuthenticated).toBe(true);
    // Obviously-synthetic marker, never a real Clerk id.
    expect(auth.userId).toContain("e2e_local_trusted");
  });

  it("has() reports the synthetic org-admin role and nothing else", () => {
    const auth = buildLocalTrustedAuth();

    expect(auth.has({ role: LOCAL_TRUSTED_ORG_ROLE })).toBe(true);
    expect(auth.has({ role: "org:member" })).toBe(false);
  });

  // ISS-10335. A null here is not "no token" to the render path, it is a 404:
  // `documents/[slug]/page.tsx` reads the token BEFORE calling the api and takes
  // its not-found branch when there is none, so the document page 404ed inside
  // the shell without ever issuing the by-slug request. Asserted against the
  // canonical constant because the client adapter and the e2e lane's bearer
  // helper send that same string — a literal here could agree with only one.
  it("getToken resolves the inert client token the local_trusted api accepts", async () => {
    const auth = buildLocalTrustedAuth();

    await expect(auth.getToken()).resolves.toBe(LOCAL_TRUSTED_CLIENT_TOKEN);
  });
});

describe("buildLocalTrustedUser", () => {
  it("returns a truthy fixed synthetic user with the synthetic id", () => {
    const user = buildLocalTrustedUser();

    expect(user).toBeTruthy();
    expect(user.id).toBe(LOCAL_TRUSTED_USER_ID);
    expect(user.id).toContain("e2e_local_trusted");
  });
});

// ISS-10335. The resolver is unit-tested in auth-mode.test.ts; what these pin is
// that the BUILDERS — the only things `@repo/auth/server` returns, and therefore
// the only thing `withAuth` ever sees — actually read it. Without this, the
// override could resolve correctly and the session still report the default.
describe("the synthetic session follows the configured identity", () => {
  const SEEDED_ORG_ID = "org_2seededsandbox";
  const SEEDED_ORG_SLUG = "seed-sandbox";
  const SEEDED_USER_ID = "user_2seededsandbox";
  const MUTATED_ENV_KEYS = [
    "AUTH_MODE",
    E2E_LOCAL_TRUSTED_AUTH_ENV,
    E2E_LOCAL_TRUSTED_ORG_ID_ENV,
    E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
    E2E_LOCAL_TRUSTED_USER_ID_ENV,
    E2E_LOCAL_TRUSTED_ORG_NAME_ENV,
    E2E_LOCAL_TRUSTED_USER_EMAIL_ENV,
    E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV,
    E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV,
    "NODE_ENV",
    "VERCEL_ENV",
  ];
  const originalEnv = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      setEnv(key, value);
    }
    originalEnv.clear();
  });

  function bindSeededIdentity(): void {
    for (const key of MUTATED_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");
    setEnv(E2E_LOCAL_TRUSTED_ORG_ID_ENV, SEEDED_ORG_ID);
    setEnv(E2E_LOCAL_TRUSTED_ORG_SLUG_ENV, SEEDED_ORG_SLUG);
    setEnv(E2E_LOCAL_TRUSTED_USER_ID_ENV, SEEDED_USER_ID);
  }

  it("reports the configured org and user on the auth object AND its claims", () => {
    bindSeededIdentity();
    const auth = buildLocalTrustedAuth();

    expect(auth.orgId).toBe(SEEDED_ORG_ID);
    expect(auth.orgSlug).toBe(SEEDED_ORG_SLUG);
    expect(auth.userId).toBe(SEEDED_USER_ID);
    // The claims are a second copy of the same three values, and `withAuth`
    // reads the object while other consumers read the claims — so a builder that
    // updated only one half would authenticate as two different identities.
    expect(auth.sessionClaims?.org_id).toBe(SEEDED_ORG_ID);
    expect(auth.sessionClaims?.org_slug).toBe(SEEDED_ORG_SLUG);
    expect(auth.sessionClaims?.sub).toBe(SEEDED_USER_ID);
    // Unaffected: the role and session id are not identity bindings and stay
    // fixed, which is what keeps the admin lane's `org:admin` treatment.
    expect(auth.orgRole).toBe(LOCAL_TRUSTED_ORG_ROLE);
    expect(auth.sessionId).toBe(LOCAL_TRUSTED_SESSION_ID);
  });

  it("reports the configured user id on currentUser()", () => {
    bindSeededIdentity();

    expect(buildLocalTrustedUser().id).toBe(SEEDED_USER_ID);
  });

  it("reports the configured person on currentUser()", () => {
    // ISS-12135: the vibe stack's seeded owner, by name and staff email.
    bindSeededIdentity();
    setEnv(E2E_LOCAL_TRUSTED_ORG_NAME_ENV, "Acme Co");
    setEnv(E2E_LOCAL_TRUSTED_USER_EMAIL_ENV, "maya.okafor@closedloop.ai");
    setEnv(E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV, "Maya");
    setEnv(E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV, "Okafor");

    const user = buildLocalTrustedUser();

    expect(user.emailAddresses.at(0)?.emailAddress).toBe(
      "maya.okafor@closedloop.ai"
    );
    expect(user.firstName).toBe("Maya");
    expect(user.lastName).toBe("Okafor");
    expect(user.fullName).toBe("Maya Okafor");
  });
});
