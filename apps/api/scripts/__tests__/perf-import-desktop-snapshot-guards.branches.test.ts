/**
 * ISS-11280 — branch-pinning coverage for
 * `perf-import-desktop-snapshot-guards.ts` gaps the main import suite does not
 * reach: an unparseable `DATABASE_URL`, a `git check-ignore` spawn failure
 * (rather than a clean non-zero exit), and the identity-resolution branches
 * (`resolveIdentity` / `findSoleOrganizationId` / `findSoleUserId`), which need
 * a mocked `@repo/database` rather than the real perf database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: mocks.spawnSync };
});

import {
  checkDatabaseUrl,
  checkOutPathIsGitIgnored,
  GuardRefusalCode,
  resolveIdentity,
} from "../perf-import-desktop-snapshot-guards";

function makeFakeDb(
  organizations: { id?: string }[],
  users: { id?: string }[]
) {
  return {
    organization: {
      findMany: vi.fn().mockResolvedValue(organizations),
    },
    user: {
      findMany: vi.fn().mockResolvedValue(users),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkDatabaseUrl", () => {
  it("refuses a DATABASE_URL that is not a parseable URL", () => {
    const result = checkDatabaseUrl("this is not a url");

    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: GuardRefusalCode.DatabaseUrlUnparseable,
        message: expect.stringContaining("not a parseable URL"),
      },
    });
  });
});

describe("checkOutPathIsGitIgnored", () => {
  it("refuses when the git check-ignore probe itself fails to spawn", () => {
    mocks.spawnSync.mockReturnValueOnce({
      error: new Error("spawn git ENOENT"),
      status: null,
    });

    const result = checkOutPathIsGitIgnored("/tmp/does-not-matter/out.json");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe(
      GuardRefusalCode.OutPathNotGitIgnored
    );
    expect(!result.ok && result.error.message).toContain("spawn error");
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "git",
      ["check-ignore", "--quiet", "--", "/tmp/does-not-matter/"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
  });

  // Isolates the `||` in `probe.error || probe.status !== 0` from a version
  // that would only refuse when BOTH held — an explicit non-null `status: 0`
  // alongside `error` keeps the second clause false, so only the first clause
  // can be doing the work.
  it("refuses on a spawn error even when the probe also carries a zero status", () => {
    mocks.spawnSync.mockReturnValueOnce({
      error: new Error("spawn git ENOENT"),
      status: 0,
    });

    const result = checkOutPathIsGitIgnored("/tmp/does-not-matter/out.json");

    expect(!result.ok && result.error.code).toBe(
      GuardRefusalCode.OutPathNotGitIgnored
    );
  });
});

describe("resolveIdentity", () => {
  it("refuses as organization-ambiguous when the database holds zero organizations", async () => {
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(makeFakeDb([], []))
    );

    const result = await resolveIdentity();

    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: GuardRefusalCode.OrganizationAmbiguous,
        message: expect.stringContaining("organization"),
      },
    });
  });

  it("refuses as organization-ambiguous when the database holds more than one organization", async () => {
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(makeFakeDb([{ id: "org-1" }, { id: "org-2" }], []))
    );

    const result = await resolveIdentity();

    expect(!result.ok && result.error.code).toBe(
      GuardRefusalCode.OrganizationAmbiguous
    );
  });

  it("refuses as organization-ambiguous when the sole organization row carries no id", async () => {
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(makeFakeDb([{}], []))
    );

    const result = await resolveIdentity();

    expect(!result.ok && result.error.code).toBe(
      GuardRefusalCode.OrganizationAmbiguous
    );
  });

  it("skips the organization lookup entirely when an override is passed", async () => {
    const db = makeFakeDb([{ id: "should-not-be-read" }], [{ id: "user-1" }]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await resolveIdentity({ organizationId: "org-override" });

    expect(db.organization.findMany).not.toHaveBeenCalled();
    // The user lookup must scope to the OVERRIDE id, not fall back to some
    // other organization — the override has to actually reach the query.
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-override" },
      take: 2,
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(result).toStrictEqual({
      ok: true,
      value: { organizationId: "org-override", userId: "user-1" },
    });
  });

  it("refuses as user-ambiguous when the resolved organization holds zero users", async () => {
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(makeFakeDb([{ id: "org-1" }], []))
    );

    const result = await resolveIdentity();

    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: GuardRefusalCode.UserAmbiguous,
        message:
          "organization org-1 does not hold exactly one user — pass --user-id <uuid> to say which identity to import as.",
      },
    });
  });

  it("refuses as user-ambiguous when the resolved organization holds more than one user", async () => {
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(
        makeFakeDb([{ id: "org-1" }], [{ id: "user-1" }, { id: "user-2" }])
      )
    );

    const result = await resolveIdentity();

    expect(!result.ok && result.error.code).toBe(
      GuardRefusalCode.UserAmbiguous
    );
  });

  it("refuses as user-ambiguous when the sole user row carries no id", async () => {
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(makeFakeDb([{ id: "org-1" }], [{}]))
    );

    const result = await resolveIdentity();

    expect(!result.ok && result.error.code).toBe(
      GuardRefusalCode.UserAmbiguous
    );
  });

  it("skips the user lookup entirely when an override is passed", async () => {
    const db = makeFakeDb([{ id: "org-1" }], [{ id: "should-not-be-read" }]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await resolveIdentity({ userId: "user-override" });

    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      ok: true,
      value: { organizationId: "org-1", userId: "user-override" },
    });
  });

  it("resolves the sole organization and sole user when neither override is passed", async () => {
    const db = makeFakeDb([{ id: "org-1" }], [{ id: "user-1" }]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await resolveIdentity();

    expect(result).toStrictEqual({
      ok: true,
      value: { organizationId: "org-1", userId: "user-1" },
    });
    expect(db.organization.findMany).toHaveBeenCalledWith({
      take: 2,
      select: { id: true },
      orderBy: { id: "asc" },
    });
    // The user lookup is scoped to the RESOLVED organization — asserting the
    // full `where` shape is what would catch this collapsing to an
    // unscoped, cross-organization lookup.
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      take: 2,
      select: { id: true },
      orderBy: { id: "asc" },
    });
  });
});
