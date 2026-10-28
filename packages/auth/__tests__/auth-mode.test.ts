import { afterEach, describe, expect, it } from "vitest";
// Relative, not `@repo/api`: this package does not depend on that one, and the
// trip-wire at the bottom of this file exists precisely to keep the copy honest
// WITHOUT adding the dependency that would make the copy unnecessary.
import {
  LOCAL_TRUSTED_DEFAULT_ORG_ID,
  LOCAL_TRUSTED_DEFAULT_USER_ID,
} from "../../api/src/types/local-trusted-auth";
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
  hasLocalTrustedDisplayOverrides,
  isLocalTrustedAuthActive,
  isLocalTrustedAuthConfigured,
  isNonProductionEnvironment,
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_EMAIL,
  LOCAL_TRUSTED_USER_FIRST_NAME,
  LOCAL_TRUSTED_USER_FULL_NAME,
  LOCAL_TRUSTED_USER_ID,
  LOCAL_TRUSTED_USER_LAST_NAME,
  resolveLocalTrustedIdentity,
  resolveLocalTrustedUserProfile,
} from "../auth-mode";

// FEA-4334: the whole security boundary of the local_trusted feature lives in
// isLocalTrustedAuthActive. These tests prove: (1) it NEVER grants a synthetic
// session in production/stage/preview — the guard-OFF branch throws rather than
// falling back silently — and (2) it DOES resolve synthetic auth only when the
// explicit non-production signal is set. The env keys these mutate are restored
// EXACTLY in afterEach (deleted when originally unset; never assigned
// "undefined").

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
  "VERCEL",
  "AWS_EXECUTION_ENV",
  "NEXT_PUBLIC_APP_ENVIRONMENT",
] as const;

const SEEDED_ORG_ID = "org_2seededsandbox";
const SEEDED_ORG_SLUG = "seed-sandbox";
const SEEDED_USER_ID = "user_2seededsandbox";

const DEFAULT_IDENTITY = {
  orgId: LOCAL_TRUSTED_ORG_ID,
  orgSlug: LOCAL_TRUSTED_ORG_SLUG,
  userId: LOCAL_TRUSTED_USER_ID,
};

const REFUSED_PATTERN = /refused/;

const originalEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

/**
 * Put the process into a clean, fully-explicit non-production local_trusted
 * state: AUTH_MODE=local_trusted, the opt-in signal on, NODE_ENV=test, and no
 * Vercel deploy env. Individual tests then flip exactly one dimension to prove
 * that dimension gates.
 */
function enableLocalTrusted(): void {
  setEnv("AUTH_MODE", AuthMode.LocalTrusted);
  setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
  setEnv("NODE_ENV", "test");
  setEnv("VERCEL_ENV", undefined);
}

/**
 * Snapshot + clear the keys under test before each case so inherited local/CI
 * state (a real AUTH_MODE, NODE_ENV=production, a VERCEL_ENV) cannot satisfy an
 * earlier branch and mask a regression.
 */
function isolateEnv(): void {
  for (const key of MUTATED_ENV_KEYS) {
    if (!originalEnv.has(key)) {
      originalEnv.set(key, process.env[key]);
    }
    Reflect.deleteProperty(process.env, key);
  }
}

describe("auth-mode local_trusted guard", () => {
  afterEach(() => {
    for (const [key, value] of originalEnv) {
      setEnv(key, value);
    }
    originalEnv.clear();
  });

  it("defaults to clerk when AUTH_MODE is unset (no synthetic session)", () => {
    isolateEnv();
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");

    expect(isLocalTrustedAuthConfigured()).toBe(false);
    expect(isLocalTrustedAuthActive()).toBe(false);
  });

  it("stays clerk when AUTH_MODE=clerk even with the e2e signal set", () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.Clerk);
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");

    expect(isLocalTrustedAuthActive()).toBe(false);
  });

  it("resolves the synthetic session in non-prod with the explicit signal", () => {
    isolateEnv();
    enableLocalTrusted();

    expect(isLocalTrustedAuthConfigured()).toBe(true);
    expect(isNonProductionEnvironment()).toBe(true);
    expect(isLocalTrustedAuthActive()).toBe(true);
  });

  it("THROWS (never grants) when AUTH_MODE=local_trusted in production", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", "production");

    expect(isNonProductionEnvironment()).toBe(false);
    // Guard-OFF branch: must throw, not fall back to clerk and not return true.
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS when AUTH_MODE=local_trusted on a Vercel production deploy", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", "test");
    setEnv("VERCEL_ENV", "production");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS on a Vercel preview deploy (internet-reachable, must stay gated)", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", "test");
    setEnv("VERCEL_ENV", "preview");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  // ISS-12054: off Vercel the guard used to reduce to NODE_ENV plus the two
  // opt-ins, so a deployed task that never set NODE_ENV would grant the session.
  it("THROWS on an ECS-like task with NODE_ENV unset (AWS_EXECUTION_ENV set)", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", undefined);
    setEnv("AWS_EXECUTION_ENV", "AWS_ECS_FARGATE");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS on any Vercel runtime (VERCEL set) even with VERCEL_ENV absent", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("VERCEL", "1");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it.each(["production", "stage"])(
    "THROWS when NEXT_PUBLIC_APP_ENVIRONMENT=%s",
    (appEnvironment) => {
      isolateEnv();
      enableLocalTrusted();
      setEnv("NEXT_PUBLIC_APP_ENVIRONMENT", appEnvironment);

      expect(isNonProductionEnvironment()).toBe(false);
      expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
    }
  );

  it("still grants a local stack that names itself development, with NODE_ENV unset", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv("NODE_ENV", undefined);
    setEnv("NEXT_PUBLIC_APP_ENVIRONMENT", "development");

    expect(isLocalTrustedAuthActive()).toBe(true);
  });

  it("THROWS when the explicit e2e signal is missing (mode alone is not enough)", () => {
    isolateEnv();
    setEnv("AUTH_MODE", AuthMode.LocalTrusted);
    setEnv("NODE_ENV", "test");
    // E2E_LOCAL_TRUSTED_AUTH intentionally unset.

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS when the e2e signal is any value other than exactly '1'", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "true");

    expect(isNonProductionEnvironment()).toBe(false);
    expect(() => isLocalTrustedAuthActive()).toThrow(REFUSED_PATTERN);
  });
});

// ISS-10335: the synthetic identity became configurable so the Clerk-free e2e
// lane can BE the seeded sandbox org. The overrides must never be a second way
// in — they are read only past the guard above, which is why the production and
// preview cases below set them and still get a throw rather than an identity.
describe("resolveLocalTrustedIdentity", () => {
  afterEach(() => {
    for (const [key, value] of originalEnv) {
      setEnv(key, value);
    }
    originalEnv.clear();
  });

  function setSeededOverrides(): void {
    setEnv(E2E_LOCAL_TRUSTED_ORG_ID_ENV, SEEDED_ORG_ID);
    setEnv(E2E_LOCAL_TRUSTED_ORG_SLUG_ENV, SEEDED_ORG_SLUG);
    setEnv(E2E_LOCAL_TRUSTED_USER_ID_ENV, SEEDED_USER_ID);
  }

  it("reports the fixed defaults when no override is set", () => {
    isolateEnv();
    enableLocalTrusted();

    expect(resolveLocalTrustedIdentity()).toEqual(DEFAULT_IDENTITY);
  });

  it("reports the overrides when local_trusted is active", () => {
    isolateEnv();
    enableLocalTrusted();
    setSeededOverrides();

    expect(resolveLocalTrustedIdentity()).toEqual({
      orgId: SEEDED_ORG_ID,
      orgSlug: SEEDED_ORG_SLUG,
      userId: SEEDED_USER_ID,
    });
  });

  it("ignores the overrides entirely when the mode resolves to clerk", () => {
    isolateEnv();
    setSeededOverrides();
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");
    // AUTH_MODE intentionally unset — this is a Clerk deployment that happens to
    // carry a stale override, and it must not become a half-applied identity.

    expect(resolveLocalTrustedIdentity()).toEqual(DEFAULT_IDENTITY);
  });

  it("treats a blank or whitespace-only override as unset", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv(E2E_LOCAL_TRUSTED_ORG_ID_ENV, "");
    setEnv(E2E_LOCAL_TRUSTED_ORG_SLUG_ENV, "   ");
    setEnv(E2E_LOCAL_TRUSTED_USER_ID_ENV, SEEDED_USER_ID);

    // The compose file forwards `${SEED_SANDBOX_CLERK_ORG_ID:-}`, so "supplied
    // but empty" is the everyday unprovisioned shape, not a malformed one.
    expect(resolveLocalTrustedIdentity()).toEqual({
      ...DEFAULT_IDENTITY,
      userId: SEEDED_USER_ID,
    });
  });

  it("trims a surrounding-whitespace override rather than binding to it", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv(E2E_LOCAL_TRUSTED_ORG_ID_ENV, `  ${SEEDED_ORG_ID}  `);

    expect(resolveLocalTrustedIdentity().orgId).toBe(SEEDED_ORG_ID);
  });

  it("THROWS in production even with every override supplied", () => {
    isolateEnv();
    enableLocalTrusted();
    setSeededOverrides();
    setEnv("NODE_ENV", "production");

    expect(() => resolveLocalTrustedIdentity()).toThrow(REFUSED_PATTERN);
  });

  it("THROWS on a Vercel preview deploy even with every override supplied", () => {
    isolateEnv();
    enableLocalTrusted();
    setSeededOverrides();
    setEnv("VERCEL_ENV", "preview");

    expect(() => resolveLocalTrustedIdentity()).toThrow(REFUSED_PATTERN);
  });
});

// ISS-10335: the Playwright tree cannot import a named export from this
// CommonJS package at runtime, so `packages/api/src/types/local-trusted-auth.ts`
// carries a readable copy of the two default ids for the e2e suite to key a
// saved view by. This is the trip-wire that keeps the copy honest — the module
// above stays the producer, and a change to either value must reach both.
describe("the e2e-readable copy of the default identity", () => {
  it("matches the ids the synthetic session actually reports", () => {
    expect(LOCAL_TRUSTED_USER_ID).toBe(LOCAL_TRUSTED_DEFAULT_USER_ID);
    expect(LOCAL_TRUSTED_ORG_ID).toBe(LOCAL_TRUSTED_DEFAULT_ORG_ID);
  });
});

// ISS-12135: `pnpm vibe up` names the seeded org and owner through display
// overrides; every other lane leaves them unset and must see no change at all.
describe("local_trusted display overrides", () => {
  afterEach(() => {
    for (const [key, value] of originalEnv) {
      setEnv(key, value);
    }
    originalEnv.clear();
  });

  function setVibeDisplayOverrides(): void {
    setEnv(E2E_LOCAL_TRUSTED_ORG_NAME_ENV, "Acme Co");
    setEnv(E2E_LOCAL_TRUSTED_USER_EMAIL_ENV, "maya.okafor@closedloop.ai");
    setEnv(E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV, "Maya");
    setEnv(E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV, "Okafor");
  }

  it("carries no display field when none is set", () => {
    isolateEnv();
    enableLocalTrusted();

    const identity = resolveLocalTrustedIdentity();

    expect(Object.keys(identity).sort()).toEqual([
      "orgId",
      "orgSlug",
      "userId",
    ]);
    expect(resolveLocalTrustedUserProfile(identity)).toEqual({
      email: LOCAL_TRUSTED_USER_EMAIL,
      firstName: LOCAL_TRUSTED_USER_FIRST_NAME,
      lastName: LOCAL_TRUSTED_USER_LAST_NAME,
      fullName: LOCAL_TRUSTED_USER_FULL_NAME,
    });
  });

  it("reports the vibe stack's seeded org and owner beside the default ids", () => {
    isolateEnv();
    enableLocalTrusted();
    setVibeDisplayOverrides();
    setEnv(E2E_LOCAL_TRUSTED_ORG_SLUG_ENV, "acme-co");

    const identity = resolveLocalTrustedIdentity();

    expect(identity).toEqual({
      orgId: LOCAL_TRUSTED_ORG_ID,
      orgSlug: "acme-co",
      userId: LOCAL_TRUSTED_USER_ID,
      orgName: "Acme Co",
      userEmail: "maya.okafor@closedloop.ai",
      userFirstName: "Maya",
      userLastName: "Okafor",
    });
    expect(resolveLocalTrustedUserProfile(identity)).toEqual({
      email: "maya.okafor@closedloop.ai",
      firstName: "Maya",
      lastName: "Okafor",
      fullName: "Maya Okafor",
    });
  });

  it("treats a blank display override as unset and trims a set one", () => {
    isolateEnv();
    enableLocalTrusted();
    setEnv(E2E_LOCAL_TRUSTED_ORG_NAME_ENV, "   ");
    setEnv(E2E_LOCAL_TRUSTED_USER_EMAIL_ENV, "");
    setEnv(E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV, "  Maya  ");

    const identity = resolveLocalTrustedIdentity();

    expect(identity).not.toHaveProperty("orgName");
    expect(identity).not.toHaveProperty("userEmail");
    expect(identity.userFirstName).toBe("Maya");
    expect(resolveLocalTrustedUserProfile(identity).email).toBe(
      LOCAL_TRUSTED_USER_EMAIL
    );
  });

  it("ignores the display overrides when the mode resolves to clerk", () => {
    isolateEnv();
    setVibeDisplayOverrides();
    setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, "1");
    setEnv("NODE_ENV", "test");

    expect(resolveLocalTrustedIdentity()).toEqual(DEFAULT_IDENTITY);
    expect(resolveLocalTrustedIdentity()).not.toHaveProperty("orgName");
  });

  it("THROWS in production with the display overrides supplied", () => {
    isolateEnv();
    enableLocalTrusted();
    setVibeDisplayOverrides();
    setEnv("NODE_ENV", "production");

    expect(() => resolveLocalTrustedIdentity()).toThrow(REFUSED_PATTERN);
  });
});

describe("hasLocalTrustedDisplayOverrides", () => {
  it("is false for the fixed identity and true once any display field is named", () => {
    expect(hasLocalTrustedDisplayOverrides(DEFAULT_IDENTITY)).toBe(false);
    expect(
      hasLocalTrustedDisplayOverrides({
        ...DEFAULT_IDENTITY,
        orgName: "Acme Co",
      })
    ).toBe(true);
    expect(
      hasLocalTrustedDisplayOverrides({
        ...DEFAULT_IDENTITY,
        userLastName: "Avery",
      })
    ).toBe(true);
  });
});
