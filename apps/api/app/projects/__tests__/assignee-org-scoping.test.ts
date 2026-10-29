/**
 * ISS-9487 — `assigneeId` is resolved against the caller's own organization
 * before a project write's transaction opens, and a miss is a `Result.err`.
 *
 * `projects.assignee_id` carries a real FK to `users.id`, so the column alone
 * cannot express this rule: a user in ANOTHER organization satisfies the FK.
 * The write used to commit, `findById` then projected that foreign user's name
 * and avatar into the org's project list, and the route dispatched an
 * assignment notification to them. `documentsService` already applied the rule
 * to an artifact's assignee (`validateUserInOrg`); projects did not.
 *
 * Two organizations on purpose: a single-org fixture cannot tell a scoped
 * lookup from an unscoped one. The fake uses Prisma's own semantics — a key
 * ABSENT from the `where` constrains nothing — so deleting `organizationId`
 * from the `isUserInOrganization` lookup makes the foreign user resolve and
 * reddens the refusal cases.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("PRO-1"),
}));

vi.mock("@/app/search/search-index-service", () => ({
  projectProjection: vi.fn((input: unknown) => input),
  searchIndexService: {
    indexAfterCommit: vi.fn(),
    removeAfterCommit: vi.fn(),
  },
}));

import { Result, Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { generateSlug } from "@/lib/slug-generator";
import { USER_NOT_IN_ORGANIZATION_MESSAGE } from "@/lib/user-org-membership";
import { projectsService } from "../service";

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_IN_A = "user-in-a";
const USER_IN_B = "user-in-b";
const TEAM_IN_A = "team-in-a";
const PROJECT_IN_A = "project-in-a";

const USERS: Array<{ id: string; organizationId: string }> = [
  { id: USER_IN_A, organizationId: ORG_A },
  { id: USER_IN_B, organizationId: ORG_B },
];

/**
 * Prisma semantics: an absent `where` key constrains nothing. That is what
 * makes this causal rather than a restatement of the argument the service was
 * handed.
 */
function userFindFirstImpl({
  where,
}: {
  where: { id?: string; organizationId?: string };
}) {
  const row = USERS.find((u) => u.id === where.id);
  if (!row) {
    return Promise.resolve(null);
  }
  if (
    where.organizationId !== undefined &&
    where.organizationId !== row.organizationId
  ) {
    return Promise.resolve(null);
  }
  return Promise.resolve({ id: row.id });
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_IN_A,
    organizationId: ORG_A,
    name: "Project A",
    slug: "PRO-1",
    description: null,
    assigneeId: null,
    status: "NOT_STARTED",
    priority: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

const projectUpdate = vi.fn((args: { data: Record<string, unknown> }) =>
  Promise.resolve(projectRow(args.data))
);
const projectCreate = vi.fn((args: { data: Record<string, unknown> }) =>
  Promise.resolve(projectRow(args.data))
);

/**
 * Module-level so a case can assert that a write which names no user never
 * reached the lookup at all. `vi.clearAllMocks` clears calls and keeps the
 * implementation, and `beforeEach` restores it anyway.
 */
const userFindFirst = vi.fn(userFindFirstImpl);

const refused = Result.err({
  status: Status.BadRequest,
  message: USER_NOT_IN_ORGANIZATION_MESSAGE,
});

function buildTx() {
  return {
    $queryRaw: vi.fn(() =>
      Promise.resolve([{ status: "NOT_STARTED", priority: null }])
    ),
    project: {
      update: projectUpdate,
      create: projectCreate,
      findFirst: vi.fn(() => Promise.resolve(null)),
    },
    team: {
      findMany: vi.fn(() => Promise.resolve([{ id: TEAM_IN_A }])),
    },
    projectTeam: {
      findMany: vi.fn(() => Promise.resolve([])),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      createMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
  };
}

describe("projectsService assignee org scoping (ISS-9487)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindFirst.mockImplementation(userFindFirstImpl);
    (withDb as unknown as { tx: Mock }).tx.mockImplementation(
      (cb: (tx: unknown) => unknown) => Promise.resolve(cb(buildTx()))
    );
    // The assignee lookup runs through a plain `withDb` before the transaction
    // opens. `indexProjectProjection` also reads the owning team through one
    // after commit; that is fire-and-forget and must not throw past the write.
    (withDb as unknown as Mock).mockImplementation(
      (cb: (db: unknown) => unknown) =>
        Promise.resolve(
          cb({
            user: { findFirst: userFindFirst },
            projectTeam: { findFirst: vi.fn(() => Promise.resolve(null)) },
          })
        )
    );
  });

  it("update accepts an assignee in the caller's own organization", async () => {
    const result = await projectsService.update(PROJECT_IN_A, ORG_A, {
      assigneeId: USER_IN_A,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { project: { assigneeId: USER_IN_A } },
    });
    expect(projectUpdate).toHaveBeenCalledTimes(1);
  });

  it("update refuses an assignee from another organization, before the transaction opens", async () => {
    const result = await projectsService.update(PROJECT_IN_A, ORG_A, {
      assigneeId: USER_IN_B,
    });

    expect(result).toEqual(refused);
    // The refusal has to land BEFORE persistence, not as a rollback after it.
    expect(withDb.tx).not.toHaveBeenCalled();
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it("refuses a foreign assignee and an unknown one identically", async () => {
    // Same result for both, so the refusal cannot be used to tell a user in
    // another organization apart from one that does not exist.
    const foreign = await projectsService.update(PROJECT_IN_A, ORG_A, {
      assigneeId: USER_IN_B,
    });
    const unknown = await projectsService.update(PROJECT_IN_A, ORG_A, {
      assigneeId: "00000000-0000-0000-0000-000000000000",
    });

    expect(foreign).toEqual(refused);
    expect(unknown).toEqual(foreign);
  });

  it("create refuses an assignee from another organization, before the transaction opens", async () => {
    const result = await projectsService.create(ORG_A, USER_IN_A, {
      name: "New project",
      assigneeId: USER_IN_B,
      teamIds: [TEAM_IN_A],
    });

    expect(result).toEqual(refused);
    expect(withDb.tx).not.toHaveBeenCalled();
    expect(generateSlug).not.toHaveBeenCalled();
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("create accepts an assignee in the caller's own organization", async () => {
    const result = await projectsService.create(ORG_A, USER_IN_A, {
      name: "New project",
      assigneeId: USER_IN_A,
      teamIds: [TEAM_IN_A],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { assigneeId: USER_IN_A },
    });
    expect(generateSlug).toHaveBeenCalledTimes(1);
    expect(projectCreate).toHaveBeenCalledTimes(1);
  });

  it("update refuses an assignee id that names no user at all", async () => {
    const result = await projectsService.update(PROJECT_IN_A, ORG_A, {
      assigneeId: "00000000-0000-0000-0000-000000000000",
    });

    expect(result).toEqual(refused);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it("update clears the assignee on an explicit null without a lookup", async () => {
    const result = await projectsService.update(PROJECT_IN_A, ORG_A, {
      assigneeId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { project: { assigneeId: null } },
    });
    expect(projectUpdate).toHaveBeenCalledTimes(1);
    // "without a lookup" is the claim, so it is the assertion: a `null` names
    // nobody, so the guard must return before reaching the user table.
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("update leaves the assignee untouched, and unlooked-up, when the key is omitted", async () => {
    const result = await projectsService.update(PROJECT_IN_A, ORG_A, {
      name: "Renamed",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { project: { name: "Renamed" } },
    });
    expect(projectUpdate).toHaveBeenCalledTimes(1);
    expect(projectUpdate.mock.calls[0]?.[0].data).not.toHaveProperty(
      "assigneeId"
    );
    expect(userFindFirst).not.toHaveBeenCalled();
  });
});
