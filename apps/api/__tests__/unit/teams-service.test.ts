/**
 * ISS-7535 — the Prisma-error translation in `teamsService`.
 *
 * This is where the 404/409 contract is actually decided. The route suites
 * (`__tests__/api/teams*.test.ts`) mock this service away, so they can only
 * prove "a `Result.err` becomes the right status" — delete the catch blocks
 * below and they stay green. These cases drive the real service against a
 * delegate that rejects the way Prisma does, so the mapping itself is pinned.
 */
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaKnownRequestError } from "@/__tests__/fixtures/prisma-errors";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "@/__tests__/utils/db-helpers";
import { teamsService } from "@/app/teams/service";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
}));

const ORG_ID = "org-123";
const OTHER_ORG_ID = "org-999";
const USER_ID = "user-456";
const TEAM_ID = "team-789";

function makeTeamRow(overrides?: Record<string, unknown>) {
  return {
    id: TEAM_ID,
    organizationId: ORG_ID,
    name: "Platform",
    slug: "platform",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

/**
 * Model Prisma's `$transaction` more closely than `mockWithDbTx` does: a
 * rejecting callback rolls the transaction back and rethrows to the caller.
 *
 * The returned flag is what proves the service translates the Prisma error
 * OUTSIDE the transaction. Moving the try/catch inside the callback would
 * RESOLVE it with a `Result`, so Prisma would commit a transaction whose write
 * had already failed — the exact shape `apps/api/AGENTS.md` forbids under
 * "do not catch a failed database write and continue issuing queries in the
 * same transaction".
 */
function mockRollbackAwareTx(client: Record<string, unknown>) {
  const state = { rolledBack: false };
  getMockWithDb().tx = vi.fn(async (callback: (tx: unknown) => unknown) => {
    try {
      return await callback(client);
    } catch (error) {
      state.rolledBack = true;
      throw error;
    }
  });
  return state;
}

/** The shape Prisma raises when an `update`/`delete` matches zero rows. */
function makeP2025Error() {
  return makePrismaKnownRequestError(
    "P2025",
    "An operation failed because it depends on one or more records that were required but not found."
  );
}

/**
 * `@@unique([organizationId, slug])` as the column array a pg adapter reports.
 */
function makeSlugCollisionError() {
  return makePrismaKnownRequestError("P2002", "Unique constraint failed", {
    target: ["organization_id", "slug"],
  });
}

/**
 * The same constraint as the constraint-name string other adapters report.
 * `teams_organization_id_slug_key` is the index name in the migration that
 * created it (20260203204426).
 */
function makeSlugCollisionByIndexNameError() {
  return makePrismaKnownRequestError("P2002", "Unique constraint failed", {
    target: "teams_organization_id_slug_key",
  });
}

/**
 * ISS-8804: the shape adapter-pg — the driver this app runs on — ACTUALLY
 * raises. `meta.target` is unset entirely and the constraint arrives under
 * `driverAdapterError`. Before the fix this was the only shape production ever
 * produced and the only one no test built, so the slug-conflict branch was
 * dead while the suite stayed green.
 */
function makeSlugCollisionAdapterPgError() {
  return makePrismaKnownRequestError("P2002", "Unique constraint failed", {
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23505",
        kind: "UniqueConstraintViolation",
        constraint: { index: "teams_organization_id_slug_key" },
      },
    },
  });
}

/**
 * The same envelope for `TeamMember`'s unique — a slug conflict it is not, and
 * the narrowing must still hold on the new shape.
 */
function makeMemberCollisionAdapterPgError() {
  return makePrismaKnownRequestError("P2002", "Unique constraint failed", {
    driverAdapterError: {
      cause: { constraint: { index: "team_members_team_id_user_id_key" } },
    },
  });
}

/**
 * `TeamMember`'s own `@@unique([teamId, userId])` — the other unique index
 * reachable inside `createWithOwner`'s transaction. A slug conflict it is not.
 */
function makeMemberCollisionError() {
  return makePrismaKnownRequestError("P2002", "Unique constraint failed", {
    target: ["team_id", "user_id"],
  });
}

describe("teamsService.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the updated row and scopes the write to the organization", async () => {
    const row = makeTeamRow({ name: "Renamed" });
    const team = { update: vi.fn().mockResolvedValue(row) };
    mockWithDbCall({ team });

    const result = await teamsService.update(TEAM_ID, ORG_ID, {
      name: "Renamed",
    });

    expect(result).toEqual({ ok: true, value: row });
    expect(team.update).toHaveBeenCalledWith({
      where: { id: TEAM_ID, organizationId: ORG_ID },
      data: { name: "Renamed" },
    });
  });

  it("reports NotFound when Prisma raises P2025 on a zero-row match", async () => {
    const team = { update: vi.fn().mockRejectedValue(makeP2025Error()) };
    mockWithDbCall({ team });

    const result = await teamsService.update(TEAM_ID, OTHER_ORG_ID, {
      name: "Hacked",
    });

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });

  it("reports Conflict when the new slug collides (P2002)", async () => {
    const team = {
      update: vi.fn().mockRejectedValue(makeSlugCollisionError()),
    };
    mockWithDbCall({ team });

    const result = await teamsService.update(TEAM_ID, ORG_ID, {
      slug: "taken",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
  });

  it("reports Conflict when the adapter names the constraint instead of the columns", async () => {
    const team = {
      update: vi.fn().mockRejectedValue(makeSlugCollisionByIndexNameError()),
    };
    mockWithDbCall({ team });

    const result = await teamsService.update(TEAM_ID, ORG_ID, {
      slug: "taken",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
  });

  it("reports Conflict on the envelope adapter-pg actually raises", async () => {
    // The shape production produces. Without the both-shapes read this returned
    // a 500 instead of a 409 for every real duplicate slug (ISS-8804).
    const team = {
      update: vi.fn().mockRejectedValue(makeSlugCollisionAdapterPgError()),
    };
    mockWithDbCall({ team });

    const result = await teamsService.update(TEAM_ID, ORG_ID, {
      slug: "taken",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
  });

  it("does not treat another table's slug index as a team slug conflict", async () => {
    // The string shape is an index NAME. A substring test for "slug" — what
    // this matcher used to do — also matches `organizations_slug_key`, so a
    // co-transactional conflict on a different table became a 409.
    const unrelated = makePrismaKnownRequestError(
      "P2002",
      "Unique constraint failed",
      {
        driverAdapterError: {
          cause: { constraint: { index: "organizations_slug_key" } },
        },
      }
    );
    const team = { update: vi.fn().mockRejectedValue(unrelated) };
    mockWithDbCall({ team });

    await expect(
      teamsService.update(TEAM_ID, ORG_ID, { slug: "taken" })
    ).rejects.toBe(unrelated);
  });

  it("rethrows a TeamMember P2002 on the adapter-pg envelope too", async () => {
    // The narrowing has to survive the new shape, not just the legacy one.
    const unrelated = makeMemberCollisionAdapterPgError();
    const team = { update: vi.fn().mockRejectedValue(unrelated) };
    mockWithDbCall({ team });

    await expect(
      teamsService.update(TEAM_ID, ORG_ID, { name: "Renamed" })
    ).rejects.toBe(unrelated);
  });

  it("rethrows a P2002 raised by some other unique constraint", async () => {
    const unrelated = makeMemberCollisionError();
    const team = { update: vi.fn().mockRejectedValue(unrelated) };
    mockWithDbCall({ team });

    await expect(
      teamsService.update(TEAM_ID, ORG_ID, { name: "Renamed" })
    ).rejects.toBe(unrelated);
  });

  it("rethrows a Prisma error it does not translate", async () => {
    const connectionLost = makePrismaKnownRequestError(
      "P1017",
      "Server has closed the connection."
    );
    const team = { update: vi.fn().mockRejectedValue(connectionLost) };
    mockWithDbCall({ team });

    await expect(
      teamsService.update(TEAM_ID, ORG_ID, { name: "Renamed" })
    ).rejects.toBe(connectionLost);
  });
});

describe("teamsService.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the org-scoped row and reports success", async () => {
    const team = { delete: vi.fn().mockResolvedValue(makeTeamRow()) };
    mockWithDbCall({ team });

    const result = await teamsService.delete(TEAM_ID, ORG_ID);

    expect(result).toEqual({ ok: true, value: true });
    expect(team.delete).toHaveBeenCalledWith({
      where: { id: TEAM_ID, organizationId: ORG_ID },
    });
  });

  it("writes nothing that is not organization-scoped", async () => {
    const client = {
      team: { delete: vi.fn().mockRejectedValue(makeP2025Error()) },
      teamMember: { deleteMany: vi.fn() },
      projectTeam: { deleteMany: vi.fn() },
    };
    mockWithDbCall(client);

    const result = await teamsService.delete(TEAM_ID, OTHER_ORG_ID);

    // `withDb.tx` JOINS an ambient transaction, so a rollback is not this
    // method's to assume: a caller already inside one commits whatever ran
    // before the miss. Association deletes keyed on `teamId` alone would then
    // survive a NotFound and strip another org's team. Nothing may be written
    // ahead of the scoped statement.
    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(client.teamMember.deleteMany).not.toHaveBeenCalled();
    expect(client.projectTeam.deleteMany).not.toHaveBeenCalled();
    expect(getMockWithDb().tx).not.toHaveBeenCalled();
  });

  it("reports NotFound when the org-scoped delete raises P2025", async () => {
    const team = { delete: vi.fn().mockRejectedValue(makeP2025Error()) };
    mockWithDbCall({ team });

    const result = await teamsService.delete(TEAM_ID, OTHER_ORG_ID);

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });

  it("rethrows an error it does not translate", async () => {
    const boom = new Error("connection reset");
    const team = { delete: vi.fn().mockRejectedValue(boom) };
    mockWithDbCall({ team });

    await expect(teamsService.delete(TEAM_ID, ORG_ID)).rejects.toBe(boom);
  });
});

describe("teamsService.createWithOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the created team and adds the creator as owner", async () => {
    const row = makeTeamRow();
    const tx = {
      team: { create: vi.fn().mockResolvedValue(row) },
      teamMember: { create: vi.fn().mockResolvedValue({ id: "member-1" }) },
    };
    mockWithDbTx(tx);

    const result = await teamsService.createWithOwner(ORG_ID, USER_ID, {
      name: "Platform",
    });

    expect(result).toEqual({ ok: true, value: row });
    expect(tx.teamMember.create).toHaveBeenCalledWith({
      data: { teamId: TEAM_ID, userId: USER_ID, role: "OWNER" },
      select: { id: true },
    });
  });

  it("reports Conflict when the caller-supplied slug is already taken (P2002)", async () => {
    const tx = {
      team: { create: vi.fn().mockRejectedValue(makeSlugCollisionError()) },
      teamMember: { create: vi.fn() },
    };
    mockWithDbTx(tx);

    const result = await teamsService.createWithOwner(ORG_ID, USER_ID, {
      name: "Platform",
      slug: "platform",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
    expect(tx.teamMember.create).not.toHaveBeenCalled();
  });

  it("reports Conflict when the slug generated from the name collides", async () => {
    const tx = {
      team: { create: vi.fn().mockRejectedValue(makeSlugCollisionError()) },
      teamMember: { create: vi.fn() },
    };
    mockWithDbTx(tx);

    const result = await teamsService.createWithOwner(ORG_ID, USER_ID, {
      name: "Platform",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
    expect(tx.team.create).toHaveBeenCalledWith({
      data: { organizationId: ORG_ID, name: "Platform", slug: "platform" },
    });
  });

  it("reports Conflict when the adapter names the constraint instead of the columns", async () => {
    const tx = {
      team: {
        create: vi.fn().mockRejectedValue(makeSlugCollisionByIndexNameError()),
      },
      teamMember: { create: vi.fn() },
    };
    mockWithDbTx(tx);

    const result = await teamsService.createWithOwner(ORG_ID, USER_ID, {
      name: "Platform",
      slug: "platform",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
  });

  it("reports Conflict on the ADAPTER-PG envelope, the shape production raises", async () => {
    // ISS-8804 review: the adapter-pg cases all landed under
    // `teamsService.update`, leaving this caller — the one a user hits by
    // POSTing a team with a taken slug — covered only by legacy `meta.target`
    // fixtures, i.e. green against a branch the live driver never reaches.
    const tx = {
      team: {
        create: vi.fn().mockRejectedValue(makeSlugCollisionAdapterPgError()),
      },
      teamMember: { create: vi.fn() },
    };
    mockWithDbTx(tx);

    const result = await teamsService.createWithOwner(ORG_ID, USER_ID, {
      name: "Platform",
      slug: "platform",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
  });

  it("rethrows the membership unique on that envelope, where it is REACHABLE", async () => {
    // This negative belongs here rather than under `update`. `update`'s path is
    // a single `db.team.update` that cannot touch `team_members`, so the same
    // fixture there depicts a collision that cannot occur; this transaction
    // writes BOTH tables, which is the whole reason the target is checked.
    const unrelated = makeMemberCollisionAdapterPgError();
    const tx = {
      team: { create: vi.fn().mockResolvedValue(makeTeamRow()) },
      teamMember: { create: vi.fn().mockRejectedValue(unrelated) },
    };
    mockWithDbTx(tx);

    await expect(
      teamsService.createWithOwner(ORG_ID, USER_ID, { name: "Platform" })
    ).rejects.toBe(unrelated);
  });

  it("rethrows the membership unique violation instead of calling it a slug conflict", async () => {
    const unrelated = makeMemberCollisionError();
    const tx = {
      team: { create: vi.fn().mockResolvedValue(makeTeamRow()) },
      teamMember: { create: vi.fn().mockRejectedValue(unrelated) },
    };
    mockWithDbTx(tx);

    // The transaction also writes TeamMember, so a P2002 in here is not
    // necessarily the slug: reporting 409 would tell the caller to pick a new
    // slug for a collision that has nothing to do with one.
    await expect(
      teamsService.createWithOwner(ORG_ID, USER_ID, { name: "Platform" })
    ).rejects.toBe(unrelated);
  });

  it("rethrows an error it does not translate", async () => {
    const boom = new Error("connection reset");
    const tx = {
      team: { create: vi.fn().mockRejectedValue(boom) },
      teamMember: { create: vi.fn() },
    };
    mockWithDbTx(tx);

    await expect(
      teamsService.createWithOwner(ORG_ID, USER_ID, { name: "Platform" })
    ).rejects.toBe(boom);
  });

  it("lets the collision reject the transaction before translating it", async () => {
    const tx = {
      team: { create: vi.fn().mockRejectedValue(makeSlugCollisionError()) },
      teamMember: { create: vi.fn() },
    };
    const transaction = mockRollbackAwareTx(tx);

    const result = await teamsService.createWithOwner(ORG_ID, USER_ID, {
      name: "Platform",
    });

    expect(result).toEqual({ ok: false, error: Status.Conflict });
    expect(transaction.rolledBack).toBe(true);
  });
});
