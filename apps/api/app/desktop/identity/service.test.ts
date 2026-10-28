import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findFirst: vi.fn(),
  getOrganization: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getOrganization: mocks.getOrganization },
}));

import { desktopIdentityService } from "./service";

function installDb() {
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) =>
    cb({ user: { findFirst: mocks.findFirst } })
  );
}

describe("desktopIdentityService.get — resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDb();
  });

  // ISS-11449 retired the org session-sync policy. Desktops built before it
  // still run an org-policy store that keeps a cached `false` when these fields
  // go absent, so the server sends an explicit allow without reading the column.
  it("sends the retired policy fields as an explicit allow, reading no policy column", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user-1",
      organizationId: "org-1",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
      organization: { name: "Closedloop", slug: "closedloop", clerkId: null },
    });

    const identity = await desktopIdentityService.get("user-1", "org-1");

    const select = mocks.findFirst.mock.calls[0]?.[0]?.select;
    expect(select?.organization?.select).not.toHaveProperty(
      "sessionSyncPolicyEnabled"
    );
    expect(identity?.sessionSyncPolicyEnabled).toBe(true);
    expect(identity?.sessionSyncPolicySupported).toBe(true);
  });

  it("returns null when the user cannot be resolved", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const identity = await desktopIdentityService.get("nobody", "org-x");

    expect(identity).toBeNull();
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
      email: "kerensa@closedloop.ai",
      firstName: "Kerensa",
      lastName: "Whitlock",
      organization: {
        name: "Closedloop",
        slug: "closedloop",
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
      email: "kerensa@closedloop.ai",
      firstName: "Kerensa",
      lastName: "Whitlock",
      organization: {
        name: "Closedloop",
        slug: "closedloop",
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
      },
    });

    const identity = await desktopIdentityService.get("user-4", "org-4");

    expect("organizationSlug" in (identity as object)).toBe(false);
  });
});

// ISS-11465 — the workspace-menu logo and avatar. The desktop renderer has no
// Clerk client, so GET /desktop/identity is the only route they reach it by.
describe("desktopIdentityService.get — workspace menu images (ISS-11465)", () => {
  beforeEach(() => {
    installDb();
    mocks.getOrganization.mockReset();
  });

  // Unconditional, never the last line of a case: a case that throws between
  // installing fake timers and restoring them leaks a frozen clock into every
  // later test in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the org logo from Clerk and the avatar from our own column", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "user_1",
      organizationId: "org_1",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: "https://img.clerk.com/user-avatar",
      organization: {
        name: "Closedloop",
        slug: "closedloop",
        clerkId: "org_clerk_1",
      },
    });
    mocks.getOrganization.mockResolvedValue({
      id: "org_clerk_1",
      name: "Closedloop",
      slug: "closedloop",
      imageUrl: "https://img.clerk.com/org-logo",
    });

    const identity = await desktopIdentityService.get("user_1", "org_1");

    expect(identity?.organizationImageUrl).toBe(
      "https://img.clerk.com/org-logo"
    );
    expect(identity?.userImageUrl).toBe("https://img.clerk.com/user-avatar");
    expect(mocks.getOrganization).toHaveBeenCalledWith("org_clerk_1");
  });

  it("OMITS both keys rather than sending null when neither exists", async () => {
    // The wire contract is omission, not `null` — an old client's passthrough
    // schema is unaffected and no consumer is handed an empty `src`.
    mocks.findFirst.mockResolvedValue({
      id: "user_1",
      organizationId: "org_1",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
      organization: {
        name: "Closedloop",
        slug: "closedloop",
        clerkId: "org_clerk_1",
      },
    });
    mocks.getOrganization.mockResolvedValue({
      id: "org_clerk_1",
      name: "Closedloop",
      slug: "closedloop",
      imageUrl: null,
    });

    const identity = await desktopIdentityService.get("user_1", "org_1");

    expect(identity).not.toHaveProperty("organizationImageUrl");
    expect(identity).not.toHaveProperty("userImageUrl");
  });

  it("still returns the identity when Clerk throws", async () => {
    // A Clerk outage must cost the logo, never the whole identity — otherwise
    // the desktop loses its name, email and org too.
    mocks.findFirst.mockResolvedValue({
      id: "user_1",
      organizationId: "org_1",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: "https://img.clerk.com/user-avatar",
      organization: {
        name: "Closedloop",
        slug: "closedloop",
        clerkId: "org_clerk_1",
      },
    });
    mocks.getOrganization.mockRejectedValue(new Error("clerk down"));

    const identity = await desktopIdentityService.get("user_1", "org_1");

    expect(identity?.email).toBe("ada@closedloop.ai");
    expect(identity).not.toHaveProperty("organizationImageUrl");
    expect(identity?.userImageUrl).toBe("https://img.clerk.com/user-avatar");
  });

  it("gives up on a Clerk that never answers rather than holding the whole identity", async () => {
    // A SLOW Clerk, not a rejecting one — the `catch` above never sees this
    // case. The desktop client aborts GET /desktop/identity at 10s, so an
    // optional logo must never be able to hold the whole identity past that.
    vi.useFakeTimers();
    mocks.findFirst.mockResolvedValue({
      id: "user_1",
      organizationId: "org_1",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: "https://img.clerk.com/user-avatar",
      organization: {
        name: "Closedloop",
        slug: "closedloop",
        clerkId: "org_clerk_1",
      },
    });
    mocks.getOrganization.mockReturnValue(new Promise(() => undefined));

    const pending = desktopIdentityService.get("user_1", "org_1");
    await vi.advanceTimersByTimeAsync(2000);
    const identity = await pending;

    expect(identity?.email).toBe("ada@closedloop.ai");
    expect(identity).not.toHaveProperty("organizationImageUrl");
    expect(identity?.userImageUrl).toBe("https://img.clerk.com/user-avatar");
  });
});
