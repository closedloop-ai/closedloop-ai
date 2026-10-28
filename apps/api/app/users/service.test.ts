import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createDatabaseMockModule } from "../../__tests__/fixtures/mock-modules";

const databaseMocks = vi.hoisted(() => {
  const withDb = vi.fn() as Mock;
  return { withDb };
});

vi.mock("@repo/database", () =>
  createDatabaseMockModule({ withDb: databaseMocks.withDb })
);

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
  },
}));

const refreshMocks = vi.hoisted(() => ({
  refreshPeopleDisplayValuesForUser: vi.fn(),
}));

vi.mock("@/app/custom-fields/people-display-refresh", () => refreshMocks);

// Imported after the vi.mock calls so the mocked `@repo/database` factory is the
// module this value resolves against (a top-level value import of a factory-
// mocked module trips Vitest 4's hoist guard). `usersService` follows the same
// after-mock ordering.
import { USER_CONTRACT_SELECT, usersService } from "./service";

describe("usersService.findByOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters inactive GitHub shadow users at the service database boundary", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "active-user",
        active: true,
        clerkId: "clerk-active",
      },
    ]);
    databaseMocks.withDb.mockImplementation((fn) => fn({ user: { findMany } }));

    const users = await usersService.findByOrganization("org-1");

    expect(users).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        active: true,
      },
      select: USER_CONTRACT_SELECT,
      orderBy: { createdAt: "desc" },
    });
  });
});

// ISS-5195: GET /users, GET /me, GET /users/:id, and PUT /users/:id all
// serialize the row these three methods return straight to the caller. Without
// an explicit select each returned every column on the Prisma model, handing
// `claudeApiKeyEncrypted` to any read-scoped API key. These assert the select is
// actually issued to Prisma — the production decision — rather than trusting the
// route's `User` return type, which a superset row satisfies structurally and so
// never caught the leak.
describe("user reads served to clients select only the public contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // GET /users' list read is covered by the findByOrganization suite above,
  // whose exact-args assertion already pins `select`.
  it("narrows the findById read behind GET /me and GET /users/:id", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    databaseMocks.withDb.mockImplementation((fn) =>
      fn({ user: { findUnique } })
    );

    await usersService.findById("user-1", "org-1");

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "user-1", organizationId: "org-1" },
      select: USER_CONTRACT_SELECT,
    });
  });

  it("narrows the row PUT /users/:id returns", async () => {
    const update = vi.fn().mockResolvedValue(null);
    databaseMocks.withDb.mockImplementation((fn) => fn({ user: { update } }));

    await usersService.update("user-1", "org-1", { firstName: "Ada" });

    // Org scoping lives in the query, not in a caller-side pre-check.
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1", organizationId: "org-1" },
      data: { firstName: "Ada" },
      select: USER_CONTRACT_SELECT,
    });
  });

  // The two auth-path producers. Neither is serialized to a client today, but
  // both feed `findOrCreateUser`, which declares `Promise<User | null>` and
  // whose result becomes `AuthContext.user` on every Clerk-session route. Left
  // unselected, that type was false and the three auth paths handed handlers
  // structurally different `user` objects — one narrowed, one carrying the
  // Claude-key trio.
  it("narrows the findByClerkIdAndOrg read behind withAuth", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    databaseMocks.withDb.mockImplementation((fn) =>
      fn({ user: { findUnique } })
    );

    await usersService.findByClerkIdAndOrg("clerk-1", "org-1");

    expect(findUnique.mock.calls[0][0].select).toEqual(USER_CONTRACT_SELECT);
  });

  it("narrows the row upsertByClerkIdAndOrg returns", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "user-1" });
    databaseMocks.withDb.mockImplementation((fn) => fn({ user: { upsert } }));

    await usersService.upsertByClerkIdAndOrg({
      clerkId: "clerk-1",
      organizationId: "org-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
      phoneNumber: null,
    });

    expect(upsert.mock.calls[0][0].select).toEqual(USER_CONTRACT_SELECT);
  });
});

// ISS-8970: every reachable writer of a user's name re-derives the cached
// PEOPLE sort keys that name them, on the client it already holds. A deleted
// call site turns its case red here; the real rewrite is pinned against
// Postgres in `custom-fields/people-display-refresh.integration.test.ts`.
describe("user-name writes refresh the cached PEOPLE sort keys", () => {
  const INPUT = {
    clerkId: "clerk-1",
    organizationId: "org-1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
    phoneNumber: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    refreshMocks.refreshPeopleDisplayValuesForUser.mockResolvedValue(0);
  });

  it("upsertByClerkIdAndOrg (un-stamped arm) refreshes the upserted row", async () => {
    const db = {
      user: { upsert: vi.fn().mockResolvedValue({ id: "user-1" }) },
    };
    databaseMocks.withDb.mockImplementation((fn) => fn(db));

    await usersService.upsertByClerkIdAndOrg(INPUT);

    expect(
      refreshMocks.refreshPeopleDisplayValuesForUser
    ).toHaveBeenCalledTimes(1);
    expect(refreshMocks.refreshPeopleDisplayValuesForUser).toHaveBeenCalledWith(
      "user-1",
      "org-1"
    );
  });

  it("upsertByClerkIdAndOrg (stamped arm) refreshes after the guarded profile write", async () => {
    const db = {
      user: {
        upsert: vi.fn().mockResolvedValue({ id: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "user-1" }),
      },
    };
    databaseMocks.withDb.mockImplementation((fn) => fn(db));

    // count 0: the stamp guard refused this delivery's profile write. The
    // refresh still runs, because a redelivery is how a failed earlier refresh
    // gets repaired.
    await usersService.upsertByClerkIdAndOrg(INPUT, new Date("2026-01-01"));

    expect(refreshMocks.refreshPeopleDisplayValuesForUser).toHaveBeenCalledWith(
      "user-1",
      "org-1"
    );
    expect(db.user.findUniqueOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      refreshMocks.refreshPeopleDisplayValuesForUser.mock.invocationCallOrder[0]
    );
  });

  it("updateByClerkId refreshes every org row for the clerkId and still returns the count", async () => {
    const db = {
      user: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([
          { id: "user-a", organizationId: "org-a" },
          { id: "user-b", organizationId: "org-b" },
        ]),
      },
    };
    databaseMocks.withDb.mockImplementation((fn) => fn(db));

    const count = await usersService.updateByClerkId(
      "clerk-1",
      { firstName: "Ada" },
      new Date("2026-01-01")
    );

    expect(count).toBe(1);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { clerkId: "clerk-1" },
      select: { id: true, organizationId: true },
    });
    expect(refreshMocks.refreshPeopleDisplayValuesForUser.mock.calls).toEqual([
      ["user-a", "org-a"],
      ["user-b", "org-b"],
    ]);
  });

  // Service-contract coverage, not production wiring: `PUT /users/:id`'s
  // validator strips `firstName`/`lastName`, so no route body reaches this
  // branch today. The hook closes the door for the next caller of the public
  // method.
  it("update refreshes when the input carries a name, and not for an avatar-only input", async () => {
    const db = { user: { update: vi.fn().mockResolvedValue(null) } };
    databaseMocks.withDb.mockImplementation((fn) => fn(db));

    await usersService.update("user-1", "org-1", { avatarUrl: "https://x/a" });
    expect(
      refreshMocks.refreshPeopleDisplayValuesForUser
    ).not.toHaveBeenCalled();

    await usersService.update("user-1", "org-1", { lastName: null });
    expect(refreshMocks.refreshPeopleDisplayValuesForUser).toHaveBeenCalledWith(
      "user-1",
      "org-1"
    );

    await usersService.update("user-1", "org-1", { firstName: "Ada" });
    expect(
      refreshMocks.refreshPeopleDisplayValuesForUser
    ).toHaveBeenCalledTimes(2);
  });

  it("a failing refresh propagates from both reachable writers (one policy, no per-writer catch)", async () => {
    refreshMocks.refreshPeopleDisplayValuesForUser.mockRejectedValue(
      new Error("refresh failed")
    );
    const db = {
      user: {
        upsert: vi.fn().mockResolvedValue({ id: "user-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "user-1", organizationId: "org-1" }]),
      },
    };
    databaseMocks.withDb.mockImplementation((fn) => fn(db));

    await expect(usersService.upsertByClerkIdAndOrg(INPUT)).rejects.toThrow(
      "refresh failed"
    );
    await expect(
      usersService.updateByClerkId(
        "clerk-1",
        { firstName: "Ada" },
        new Date("2026-01-01")
      )
    ).rejects.toThrow("refresh failed");
  });
});
