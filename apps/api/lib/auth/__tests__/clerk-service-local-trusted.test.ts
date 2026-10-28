/**
 * ISS-11468: `clerkService` under `AUTH_MODE=local_trusted`.
 *
 * The harness has no Clerk instance, so before this the boundary sent every
 * read to a provider that answers 404 for `user_e2e_local_trusted`, and the
 * guided-onboarding snapshot (among others) answered 500. The SDK client is the
 * only stub here, so every case below is falsifiable in both directions: a
 * synthetic answer that fell through to Clerk fails on `clerkClient` having
 * been called, and a guard that answered synthetically outside the harness
 * fails on it NOT having been called.
 */
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENABLED,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_NAME_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_EMAIL_ENV,
  E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
  E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV,
  LOCAL_TRUSTED_EXTERNAL_ACCOUNT_PROVIDERS,
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_NAME,
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_SESSION_ID,
  LOCAL_TRUSTED_USER_EMAIL,
  LOCAL_TRUSTED_USER_FIRST_NAME,
  LOCAL_TRUSTED_USER_ID,
  LOCAL_TRUSTED_USER_LAST_NAME,
} from "@repo/auth/auth-mode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  clerkClient: vi.fn(),
  listSeededRoster: vi.fn(),
}));

vi.mock("../seeded-roster", () => ({
  listSeededRoster: mocks.listSeededRoster,
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: mocks.clerkClient,
}));

import { clerkService, isClerkNotFound } from "../clerk-service";
import { LocalTrustedClerkUnsupportedError } from "../local-trusted-clerk-service";

/** The refusal `isLocalTrustedAuthActive` throws outside the e2e harness. */
const LOCAL_TRUSTED_REFUSED = /AUTH_MODE=local_trusted refused/;
const STRANGER_USER_ID = "user_someone_else";
const STRANGER_ORG_ID = "org_someone_else";
/** A real Chrome-on-Mac header, written as a literal: the header is not ours. */
const CHROME_MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36";

/**
 * The identity overrides `e2e/compose.yml` forwards. Cleared on activation so an
 * exported sandbox id cannot move the synthetic identity away from the
 * defaults these cases assert against.
 */
const IDENTITY_OVERRIDE_KEYS = [
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_NAME_ENV,
  E2E_LOCAL_TRUSTED_USER_EMAIL_ENV,
  E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV,
  E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV,
] as const;

/** Every key this suite writes, so `afterEach` restores the exact prior state. */
const ENV_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  ...IDENTITY_OVERRIDE_KEYS,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

/**
 * One call per `clerkService` method, so the "never reaches Clerk" and
 * "production refuses" cases cover the whole boundary rather than a sample. A
 * method added to the service without a row here fails the completeness check.
 */
const EVERY_METHOD: Record<keyof typeof clerkService, () => Promise<unknown>> =
  {
    updateOrganizationLogo: () =>
      clerkService.updateOrganizationLogo({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        uploaderUserId: LOCAL_TRUSTED_USER_ID,
        file: new File(["logo"], "logo.png", { type: "image/png" }),
      }),
    createOrganization: () =>
      clerkService.createOrganization({
        name: "x",
        slug: "x",
        createdBy: LOCAL_TRUSTED_USER_ID,
      }),
    userHasOrganization: () =>
      clerkService.userHasOrganization(LOCAL_TRUSTED_USER_ID),
    findUserOrganizationBySlug: () =>
      clerkService.findUserOrganizationBySlug(
        LOCAL_TRUSTED_USER_ID,
        LOCAL_TRUSTED_ORG_SLUG
      ),
    getOrganization: () => clerkService.getOrganization(LOCAL_TRUSTED_ORG_ID),
    updateOrganization: () =>
      clerkService.updateOrganization(LOCAL_TRUSTED_ORG_ID, { name: "x" }),
    getUser: () => clerkService.getUser(LOCAL_TRUSTED_USER_ID),
    createOrganizationInvitation: () =>
      clerkService.createOrganizationInvitation({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        emailAddress: "invitee@example.com",
        role: "org:member",
        inviterUserId: LOCAL_TRUSTED_USER_ID,
      }),
    getUserExternalAccountProviders: () =>
      clerkService.getUserExternalAccountProviders(LOCAL_TRUSTED_USER_ID),
    getOrganizationMembershipRole: () =>
      clerkService.getOrganizationMembershipRole(
        LOCAL_TRUSTED_ORG_ID,
        LOCAL_TRUSTED_USER_ID
      ),
    listOrganizationMemberships: () =>
      clerkService.listOrganizationMemberships({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        limit: 10,
        offset: 0,
      }),
    listOrganizationInvitations: () =>
      clerkService.listOrganizationInvitations({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        limit: 10,
        offset: 0,
      }),
    findUserIdsByEmail: () =>
      clerkService.findUserIdsByEmail(LOCAL_TRUSTED_USER_EMAIL),
    listUserOrganizationMemberships: () =>
      clerkService.listUserOrganizationMemberships(LOCAL_TRUSTED_USER_ID),
    getLastActiveOrganizationId: () =>
      clerkService.getLastActiveOrganizationId(LOCAL_TRUSTED_USER_ID),
    getOrganizationInvitation: () =>
      clerkService.getOrganizationInvitation({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        invitationId: "orginv_1",
      }),
    revokeOrganizationInvitation: () =>
      clerkService.revokeOrganizationInvitation({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        invitationId: "orginv_1",
        requestingUserId: LOCAL_TRUSTED_USER_ID,
      }),
    updateOrganizationMembership: () =>
      clerkService.updateOrganizationMembership({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        userId: LOCAL_TRUSTED_USER_ID,
        role: "org:member",
      }),
    deleteOrganizationMembership: () =>
      clerkService.deleteOrganizationMembership({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        userId: LOCAL_TRUSTED_USER_ID,
      }),
    listUserBrowserSessions: () =>
      clerkService.listUserBrowserSessions({
        userId: LOCAL_TRUSTED_USER_ID,
        limit: 10,
        offset: 0,
      }),
    getBrowserSessionOwner: () =>
      clerkService.getBrowserSessionOwner(LOCAL_TRUSTED_SESSION_ID),
    revokeBrowserSession: () =>
      clerkService.revokeBrowserSession(LOCAL_TRUSTED_SESSION_ID),
  };

const UNSUPPORTED_METHODS = [
  "updateOrganizationLogo",
  "updateOrganization",
  "createOrganizationInvitation",
  "revokeOrganizationInvitation",
  "updateOrganizationMembership",
  "deleteOrganizationMembership",
  "revokeBrowserSession",
] as const satisfies readonly (keyof typeof clerkService)[];

beforeEach(() => {
  mocks.getUser.mockReset();
  mocks.clerkClient.mockReset();
  mocks.clerkClient.mockResolvedValue({ users: { getUser: mocks.getUser } });
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      setEnv(key, value);
    }
  }
});

describe("clerkService under local_trusted", () => {
  beforeEach(() => {
    activateLocalTrusted();
  });

  it("covers every method of the boundary", () => {
    expect(Object.keys(EVERY_METHOD).sort()).toEqual(
      Object.keys(clerkService).sort()
    );
  });

  it.each(Object.entries(EVERY_METHOD))(
    "%s never reaches the Clerk SDK",
    async (_method, call) => {
      await call().catch(() => undefined);

      expect(mocks.clerkClient).not.toHaveBeenCalled();
    }
  );

  it.each(UNSUPPORTED_METHODS)(
    "%s refuses with a named error instead of pretending to write",
    async (method) => {
      await expect(EVERY_METHOD[method]()).rejects.toThrow(
        new LocalTrustedClerkUnsupportedError(method)
      );
    }
  );

  it("answers the guided-onboarding provider read with no linked providers", async () => {
    await expect(
      clerkService.getUserExternalAccountProviders(LOCAL_TRUSTED_USER_ID)
    ).resolves.toEqual([...LOCAL_TRUSTED_EXTERNAL_ACCOUNT_PROVIDERS]);
  });

  it("answers the synthetic user, organization and admin role", async () => {
    await expect(clerkService.getUser(LOCAL_TRUSTED_USER_ID)).resolves.toEqual({
      id: LOCAL_TRUSTED_USER_ID,
      email: LOCAL_TRUSTED_USER_EMAIL,
      firstName: LOCAL_TRUSTED_USER_FIRST_NAME,
      lastName: LOCAL_TRUSTED_USER_LAST_NAME,
      imageUrl: null,
      phoneNumber: null,
    });
    await expect(
      clerkService.getOrganization(LOCAL_TRUSTED_ORG_ID)
    ).resolves.toEqual({
      id: LOCAL_TRUSTED_ORG_ID,
      name: LOCAL_TRUSTED_ORG_NAME,
      slug: LOCAL_TRUSTED_ORG_SLUG,
      imageUrl: null,
    });
    await expect(
      clerkService.getOrganizationMembershipRole(
        LOCAL_TRUSTED_ORG_ID,
        LOCAL_TRUSTED_USER_ID
      )
    ).resolves.toBe(LOCAL_TRUSTED_ORG_ROLE);
  });

  it("lists the synthetic user as the organization's only member", async () => {
    const page = await clerkService.listOrganizationMemberships({
      organizationId: LOCAL_TRUSTED_ORG_ID,
      limit: 10,
      offset: 0,
    });

    expect(page.totalCount).toBe(1);
    expect(page.data).toEqual([
      expect.objectContaining({
        userId: LOCAL_TRUSTED_USER_ID,
        role: LOCAL_TRUSTED_ORG_ROLE,
        identifier: LOCAL_TRUSTED_USER_EMAIL,
      }),
    ]);
    await expect(
      clerkService.listOrganizationMemberships({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        limit: 10,
        offset: 1,
      })
    ).resolves.toEqual({ data: [], totalCount: 1 });
    await expect(
      clerkService.listOrganizationInvitations({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        limit: 10,
        offset: 0,
      })
    ).resolves.toEqual({ data: [], totalCount: 0 });
  });

  it("finds the synthetic user by email and its one org (ISS-12056)", async () => {
    await expect(
      clerkService.findUserIdsByEmail(LOCAL_TRUSTED_USER_EMAIL)
    ).resolves.toEqual([LOCAL_TRUSTED_USER_ID]);
    await expect(
      clerkService.findUserIdsByEmail("someone@example.com")
    ).resolves.toEqual([]);
    await expect(
      clerkService.listUserOrganizationMemberships(LOCAL_TRUSTED_USER_ID)
    ).resolves.toEqual([
      {
        organizationId: LOCAL_TRUSTED_ORG_ID,
        organizationName: LOCAL_TRUSTED_ORG_NAME,
        role: LOCAL_TRUSTED_ORG_ROLE,
      },
    ]);
    await expect(
      clerkService.listUserOrganizationMemberships(STRANGER_USER_ID)
    ).resolves.toEqual([]);
  });

  it("reports the synthetic session and who owns it", async () => {
    const sessions = await clerkService.listUserBrowserSessions({
      userId: LOCAL_TRUSTED_USER_ID,
      limit: 10,
      offset: 0,
    });

    expect(sessions.totalCount).toBe(1);
    expect(sessions.sessions.map((session) => session.id)).toEqual([
      LOCAL_TRUSTED_SESSION_ID,
    ]);
    await expect(
      clerkService.getBrowserSessionOwner(LOCAL_TRUSTED_SESSION_ID)
    ).resolves.toEqual({ userId: LOCAL_TRUSTED_USER_ID });
  });

  it("answers ids outside the synthetic identity the way Clerk answers a stranger", async () => {
    for (const read of [
      clerkService.getUser(STRANGER_USER_ID),
      clerkService.getUserExternalAccountProviders(STRANGER_USER_ID),
      clerkService.getOrganization(STRANGER_ORG_ID),
      clerkService.getOrganizationInvitation({
        organizationId: LOCAL_TRUSTED_ORG_ID,
        invitationId: "orginv_missing",
      }),
    ]) {
      const error = await read.then(
        () => null,
        (rejection: unknown) => rejection
      );
      expect(isClerkNotFound(error)).toBe(true);
    }
    await expect(
      clerkService.getOrganizationMembershipRole(
        STRANGER_ORG_ID,
        LOCAL_TRUSTED_USER_ID
      )
    ).resolves.toBeNull();
    await expect(
      clerkService.getBrowserSessionOwner("sess_someone_else")
    ).resolves.toBeNull();
    await expect(
      clerkService.listUserBrowserSessions({
        userId: STRANGER_USER_ID,
        limit: 10,
        offset: 0,
      })
    ).resolves.toEqual({ sessions: [], totalCount: 0 });
  });

  it("follows an overridden synthetic user id", async () => {
    setEnv(E2E_LOCAL_TRUSTED_USER_ID_ENV, "user_e2e_override");

    await expect(clerkService.getUser("user_e2e_override")).resolves.toEqual(
      expect.objectContaining({ id: "user_e2e_override" })
    );
    const error = await clerkService.getUser(LOCAL_TRUSTED_USER_ID).then(
      () => null,
      (rejection: unknown) => rejection
    );
    expect(isClerkNotFound(error)).toBe(true);
  });

  it("answers with the vibe stack's seeded org and owner when it names them", async () => {
    // ISS-12135: `pnpm vibe up` names Acme Co and Maya Okafor through the
    // display overrides, so the api's members list and profile agree with the
    // shell; the ids stay the defaults.
    setEnv(E2E_LOCAL_TRUSTED_ORG_NAME_ENV, "Acme Co");
    setEnv(E2E_LOCAL_TRUSTED_USER_EMAIL_ENV, "maya.okafor@closedloop.ai");
    setEnv(E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV, "Maya");
    setEnv(E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV, "Okafor");

    await expect(
      clerkService.getOrganization(LOCAL_TRUSTED_ORG_ID)
    ).resolves.toEqual(expect.objectContaining({ name: "Acme Co" }));
    await expect(clerkService.getUser(LOCAL_TRUSTED_USER_ID)).resolves.toEqual(
      expect.objectContaining({
        email: "maya.okafor@closedloop.ai",
        firstName: "Maya",
        lastName: "Okafor",
      })
    );
    await expect(
      clerkService.listUserOrganizationMemberships(LOCAL_TRUSTED_USER_ID)
    ).resolves.toEqual([
      expect.objectContaining({ organizationName: "Acme Co" }),
    ]);
    await expect(
      clerkService.findUserIdsByEmail("maya.okafor@closedloop.ai")
    ).resolves.toEqual([LOCAL_TRUSTED_USER_ID]);
    await expect(
      clerkService.findUserIdsByEmail(LOCAL_TRUSTED_USER_EMAIL)
    ).resolves.toEqual([]);
    expect(mocks.clerkClient).not.toHaveBeenCalled();
  });

  it("lists the seeded people as members when the stack names its person", async () => {
    // ISS-12135 bug 8: Settings > Members on `pnpm vibe up`.
    setEnv(E2E_LOCAL_TRUSTED_ORG_NAME_ENV, "Acme Co");
    const seeded = [
      {
        id: "orgmem_a",
        userId: "user_vibe_seed_maya_okafor",
        role: "org:owner",
      },
      { id: "orgmem_b", userId: LOCAL_TRUSTED_USER_ID, role: "org:admin" },
      {
        id: "orgmem_c",
        userId: "user_vibe_seed_daveth_reyes",
        role: "org:member",
      },
    ];
    mocks.listSeededRoster.mockResolvedValue(seeded);

    const page = await clerkService.listOrganizationMemberships({
      organizationId: LOCAL_TRUSTED_ORG_ID,
      limit: 2,
      offset: 1,
    });

    expect(mocks.listSeededRoster).toHaveBeenCalledWith({
      clerkOrgId: LOCAL_TRUSTED_ORG_ID,
      signedIn: { clerkUserId: LOCAL_TRUSTED_USER_ID, role: "org:admin" },
    });
    expect(page).toEqual({ data: seeded.slice(1, 3), totalCount: 3 });
  });

  it("keeps the one synthetic member when the stack names no person", async () => {
    const page = await clerkService.listOrganizationMemberships({
      organizationId: LOCAL_TRUSTED_ORG_ID,
      limit: 10,
      offset: 0,
    });

    expect(mocks.listSeededRoster).not.toHaveBeenCalled();
    expect(page.totalCount).toBe(1);
    expect(page.data[0]?.userId).toBe(LOCAL_TRUSTED_USER_ID);
  });

  it("keeps the fixed session row when the stack names no person", async () => {
    const { sessions } = await clerkService.listUserBrowserSessions({
      userId: LOCAL_TRUSTED_USER_ID,
      limit: 10,
      offset: 0,
      userAgent: CHROME_MAC_USER_AGENT,
    });

    expect(sessions[0]?.lastActiveAt).toBe(new Date(0).toISOString());
    expect(sessions[0]?.activity).toBeNull();
  });

  it("reports a named stack's session as live on the requesting browser", async () => {
    // ISS-12135 bug 30: the vibe stack's Connected Devices row read "Unknown
    // browser" and "Dec 31, 1969".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T05:00:00.000Z"));
    setEnv(E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV, "Jordan");

    const { sessions } = await clerkService.listUserBrowserSessions({
      userId: LOCAL_TRUSTED_USER_ID,
      limit: 10,
      offset: 0,
      userAgent: CHROME_MAC_USER_AGENT,
    });

    expect(sessions[0]?.lastActiveAt).toBe("2026-10-07T05:00:00.000Z");
    expect(sessions[0]?.activity).toEqual({
      browserName: "Chrome",
      browserVersion: "141.0.7390.54",
      deviceType: "Macintosh",
      isMobile: false,
    });
  });
});

describe("clerkService outside local_trusted", () => {
  it("asks Clerk when AUTH_MODE is not configured", async () => {
    Reflect.deleteProperty(process.env, "AUTH_MODE");
    mocks.getUser.mockResolvedValue({
      id: LOCAL_TRUSTED_USER_ID,
      primaryEmailAddressId: "idn_1",
      emailAddresses: [{ id: "idn_1", emailAddress: "real@example.com" }],
      firstName: null,
      lastName: null,
      imageUrl: "",
      phoneNumbers: [],
    });

    await expect(clerkService.getUser(LOCAL_TRUSTED_USER_ID)).resolves.toEqual(
      expect.objectContaining({ email: "real@example.com" })
    );
    expect(mocks.clerkClient).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).toHaveBeenCalledWith(LOCAL_TRUSTED_USER_ID);
  });

  it.each([
    [
      "production",
      () => {
        activateLocalTrusted();
        setEnv("NODE_ENV", "production");
      },
    ],
    [
      "a Vercel production deploy",
      () => {
        activateLocalTrusted();
        setEnv("VERCEL_ENV", "production");
      },
    ],
    [
      "a Vercel preview deploy",
      () => {
        activateLocalTrusted();
        setEnv("VERCEL_ENV", "preview");
      },
    ],
    [
      "a run without the e2e opt-in",
      () => {
        activateLocalTrusted();
        Reflect.deleteProperty(process.env, E2E_LOCAL_TRUSTED_AUTH_ENV);
      },
    ],
  ])(
    "refuses every method on %s rather than answering synthetically",
    async (_label, configure) => {
      configure();

      for (const call of Object.values(EVERY_METHOD)) {
        await expect(call()).rejects.toThrow(LOCAL_TRUSTED_REFUSED);
      }
      expect(mocks.clerkClient).not.toHaveBeenCalled();
    }
  );
});

/**
 * `NODE_ENV` is set to a non-production value and `VERCEL_ENV` and the identity
 * overrides removed explicitly, so neither an inherited deploy signal nor an
 * exported sandbox id can make the synthetic cases fail for a reason unrelated
 * to the boundary.
 */
function activateLocalTrusted(): void {
  setEnv("AUTH_MODE", AuthMode.LocalTrusted);
  setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, E2E_LOCAL_TRUSTED_AUTH_ENABLED);
  setEnv("NODE_ENV", "test");
  Reflect.deleteProperty(process.env, "VERCEL_ENV");
  for (const key of IDENTITY_OVERRIDE_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
}

/** `Reflect.set`, because `process.env.NODE_ENV` is typed read-only here. */
function setEnv(key: string, value: string): void {
  Reflect.set(process.env, key, value);
}
