import { describe, expect, it } from "vitest";
import {
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

  it("getToken resolves null (no downstream API call in the visual container)", async () => {
    const auth = buildLocalTrustedAuth();

    await expect(auth.getToken()).resolves.toBeNull();
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
