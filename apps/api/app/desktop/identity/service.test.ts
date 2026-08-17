import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

import { desktopIdentityService } from "./service";

function installDb() {
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) =>
    cb({ user: { findFirst: mocks.findFirst } })
  );
}

// FEA-4169 — the service maps the server-owned org sync policy
// (Organization.sessionSyncPolicyEnabled) onto DesktopIdentity so the desktop
// outer gate can read it from GET /desktop/identity.
describe("desktopIdentityService.get — sessionSyncPolicyEnabled (FEA-4169)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDb();
  });

  it("selects the org policy column", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "kris@closedloop.ai",
      firstName: "Kris",
      lastName: "Wong",
      organization: { name: "Closedloop", sessionSyncPolicyEnabled: true },
    });

    await desktopIdentityService.get("user-1", "org-1");

    const select = mocks.findFirst.mock.calls[0]?.[0]?.select;
    expect(select?.organization?.select?.sessionSyncPolicyEnabled).toBe(true);
  });

  it("returns true for an enabled org (e.g. Closedloop)", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "kris@closedloop.ai",
      firstName: "Kris",
      lastName: "Wong",
      organization: { name: "Closedloop", sessionSyncPolicyEnabled: true },
    });

    const identity = await desktopIdentityService.get("user-1", "org-1");

    expect(identity?.sessionSyncPolicyEnabled).toBe(true);
  });

  it("returns false for a policy-off org (the default)", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-2",
      organizationId: "org-2",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization: { name: "Acme", sessionSyncPolicyEnabled: false },
    });

    const identity = await desktopIdentityService.get("user-2", "org-2");

    expect(identity?.sessionSyncPolicyEnabled).toBe(false);
  });

  it("fails closed to false when the org relation is missing", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-3",
      organizationId: "org-3",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization: null,
    });

    const identity = await desktopIdentityService.get("user-3", "org-3");

    expect(identity?.sessionSyncPolicyEnabled).toBe(false);
  });

  it("returns null when the user cannot be resolved", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const identity = await desktopIdentityService.get("nobody", "org-x");

    expect(identity).toBeNull();
  });

  // ISS-4705 — this (current) server always advertises the versioned capability
  // marker so the desktop can distinguish it from an OLD server that predates the
  // org-sync policy. The marker is emitted regardless of the policy value.
  it("always advertises sessionSyncPolicySupported=true (enabled org)", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "kris@closedloop.ai",
      firstName: "Kris",
      lastName: "Wong",
      organization: { name: "Closedloop", sessionSyncPolicyEnabled: true },
    });

    const identity = await desktopIdentityService.get("user-1", "org-1");

    expect(identity?.sessionSyncPolicySupported).toBe(true);
  });

  it("advertises sessionSyncPolicySupported=true even when the org relation is missing", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-3",
      organizationId: "org-3",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization: null,
    });

    const identity = await desktopIdentityService.get("user-3", "org-3");

    expect(identity?.sessionSyncPolicySupported).toBe(true);
    expect(identity?.sessionSyncPolicyEnabled).toBe(false);
  });
});

// ISS-4898 — the desktop renderer holds an `organizationId` but the web app's
// artifact routes are org-SLUG-scoped, so the slug rides this payload. It is an
// additive optional wire field: the AGENTS.md cross-repo rule is that an absent
// optional value is OMITTED, never serialized as `null`, because an old client
// must be free to treat "key present" as "usable value".
describe("desktopIdentityService.get — organizationSlug (ISS-4898)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDb();
  });

  it("selects the org slug column", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "kris@closedloop.ai",
      firstName: "Kris",
      lastName: "Wong",
      organization: {
        name: "Closedloop",
        slug: "closedloop",
        sessionSyncPolicyEnabled: true,
      },
    });

    await desktopIdentityService.get("user-1", "org-1");

    const select = mocks.findFirst.mock.calls[0]?.[0]?.select;
    expect(select?.organization?.select?.slug).toBe(true);
  });

  it("emits the slug the web artifact route is scoped by", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "kris@closedloop.ai",
      firstName: "Kris",
      lastName: "Wong",
      organization: {
        name: "Closedloop",
        slug: "closedloop",
        sessionSyncPolicyEnabled: true,
      },
    });

    const identity = await desktopIdentityService.get("user-1", "org-1");

    expect(identity?.organizationSlug).toBe("closedloop");
  });

  it("OMITS the key entirely when the org relation is missing", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-3",
      organizationId: "org-3",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization: null,
    });

    const identity = await desktopIdentityService.get("user-3", "org-3");

    // Absence, not `null`: one careless `?? null` here would ship a value a
    // consumer could interpolate into `/<slug>/issues/...` and produce
    // `/null/issues/...`. Asserting the KEY is what catches that.
    expect(identity).not.toBeNull();
    expect("organizationSlug" in (identity as object)).toBe(false);
  });

  it("OMITS the key when the org row carries an empty slug", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-4",
      organizationId: "org-4",
      email: "person@example.com",
      firstName: null,
      lastName: null,
      organization: {
        name: "Acme",
        slug: "",
        sessionSyncPolicyEnabled: false,
      },
    });

    const identity = await desktopIdentityService.get("user-4", "org-4");

    expect("organizationSlug" in (identity as object)).toBe(false);
  });
});
