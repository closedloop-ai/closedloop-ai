/**
 * The move batch's service contract, both versions (ISS-9464).
 *
 * v1 is here because the per-item work pulled its write half into `applyMove`
 * and its target-project check and lock into `authorizeMoveAndLockRows`: the
 * three v1 cases pin that those extractions kept one lock, the request-order
 * sort sequence, the all-or-nothing refusal, and the target-project refusal
 * still landing before the lock. The v2 cases pin the partition.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
} from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STACK_RANK_GAP } from "@/app/documents/document-sort-order";

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  executeRaw: vi.fn(),
  projectFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  updateMany: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  Prisma: {
    join: (values: unknown[], separator = ",") => ({
      sql: values.map(() => "?").join(separator),
      values,
    }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join("?"),
      values,
    }),
  },
  withDb: mocks.withDb,
}));

import { documentBatchMoveService } from "@/app/documents/document-batch-move-service";

const ORG_ID = "00000000-0000-4000-8000-000000000010";
const TARGET_PROJECT_ID = "00000000-0000-4000-8000-000000000011";
const SOURCE_PROJECT_ID = "00000000-0000-4000-8000-000000000012";
// Lock (id ASC) order is A then B; every case sends B first, so neither order
// can pass against the other: the UPDATE tuples are pinned in REQUEST order,
// and `projectChanges` in LOCK order — the order v1 emitted activity events in
// before the shared extraction, and must keep emitting them in.
const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const MISSING_DOC = "99999999-9999-4999-8999-999999999999";
// A project that EXISTS and belongs to someone else, distinct from one that is
// absent entirely: the org predicate is the only thing that separates them.
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000020";
const FOREIGN_PROJECT_ID = "00000000-0000-4000-8000-000000000021";
const UNKNOWN_PROJECT_ID = "00000000-0000-4000-8000-000000000022";
const DEST_MAX_SORT_ORDER = 5000;

/** The projects this fake knows, by id, with the org that owns each. */
const PROJECT_OWNER: Record<string, string> = {
  [TARGET_PROJECT_ID]: ORG_ID,
  [FOREIGN_PROJECT_ID]: OTHER_ORG_ID,
};

type FakeSql = { sql: string; values: unknown[] };

function lockedRow(id: string, projectId: string | null) {
  return { id, projectId };
}

/**
 * Prisma's `where` semantics, modelled on purpose: an omitted key is not a
 * filter. A query that drops `organizationId` therefore matches on id alone and
 * resolves the foreign project, which is what makes the out-of-org cases below
 * able to fail. A fake that answered `null` regardless of its arguments would
 * stay green with the tenant predicate deleted.
 */
function findProject(where: { id: string; organizationId?: string }) {
  const owner = PROJECT_OWNER[where.id];
  if (!owner) {
    return null;
  }
  if (where.organizationId !== undefined && where.organizationId !== owner) {
    return null;
  }
  return { id: where.id };
}

/** The `UPDATE … FROM (VALUES …)` the write issued, read off the fake `Prisma`. */
function writtenUpdate() {
  const [statement] = mocks.executeRaw.mock.calls[0] as [FakeSql];
  const [targetProjectId, joined, organizationId] = statement.values as [
    string,
    FakeSql,
    string,
  ];
  return {
    targetProjectId,
    organizationId,
    tuples: (joined.values as FakeSql[]).map((row) => row.values),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectFindFirst.mockImplementation(
    ({ where }: { where: { id: string; organizationId?: string } }) =>
      Promise.resolve(findProject(where))
  );
  mocks.aggregate.mockResolvedValue({
    _max: { sortOrder: DEST_MAX_SORT_ORDER },
  });
  mocks.executeRaw.mockResolvedValue(1);
  // The lock's default: cases that care set their own rows. Without it, a case
  // that reaches the lock when it should not have fails on an undefined read
  // rather than on the assertion that says so.
  mocks.queryRaw.mockResolvedValue([]);
  mocks.withDb.tx.mockImplementation((handler: (tx: unknown) => unknown) =>
    handler({
      $executeRaw: mocks.executeRaw,
      $queryRaw: mocks.queryRaw,
      artifact: { aggregate: mocks.aggregate, updateMany: mocks.updateMany },
      project: { findFirst: mocks.projectFindFirst },
    })
  );
});

describe("documentBatchMoveService.batchMove (v1, after the shared extractions)", () => {
  it("locks once and appends every requested id in REQUEST order, reporting the transition of each row it wrote", async () => {
    mocks.queryRaw.mockResolvedValue([
      lockedRow(DOC_A, SOURCE_PROJECT_ID),
      lockedRow(DOC_B, null),
    ]);

    const result = await documentBatchMoveService.batchMove(
      [DOC_B, DOC_A, DOC_B],
      TARGET_PROJECT_ID,
      ORG_ID
    );

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
    expect(writtenUpdate()).toEqual({
      targetProjectId: TARGET_PROJECT_ID,
      organizationId: ORG_ID,
      tuples: [
        [DOC_B, DEST_MAX_SORT_ORDER + STACK_RANK_GAP],
        [DOC_A, DEST_MAX_SORT_ORDER + 2 * STACK_RANK_GAP],
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        movedIds: [DOC_B, DOC_A],
        projectChanges: [
          {
            artifactId: DOC_A,
            before: SOURCE_PROJECT_ID,
            after: TARGET_PROJECT_ID,
          },
          { artifactId: DOC_B, before: null, after: TARGET_PROJECT_ID },
        ],
      },
    });
  });

  it("refuses the whole batch when one id does not resolve, writing nothing", async () => {
    mocks.queryRaw.mockResolvedValue([lockedRow(DOC_A, SOURCE_PROJECT_ID)]);

    const result = await documentBatchMoveService.batchMove(
      [DOC_A, MISSING_DOC],
      TARGET_PROJECT_ID,
      ORG_ID
    );

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("refuses a target project that exists in another org, before taking the lock", async () => {
    const result = await documentBatchMoveService.batchMove(
      [DOC_A],
      FOREIGN_PROJECT_ID,
      ORG_ID
    );

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });
});

describe("documentBatchMoveService.batchMovePerItem (ISS-9464)", () => {
  it("moves the ids it found, in request order, and reports the rest not found", async () => {
    mocks.queryRaw.mockResolvedValue([
      lockedRow(DOC_A, SOURCE_PROJECT_ID),
      lockedRow(DOC_B, SOURCE_PROJECT_ID),
    ]);

    const result = await documentBatchMoveService.batchMovePerItem(
      [DOC_B, MISSING_DOC, DOC_A, DOC_B],
      TARGET_PROJECT_ID,
      ORG_ID
    );

    expect(writtenUpdate().tuples).toEqual([
      [DOC_B, DEST_MAX_SORT_ORDER + STACK_RANK_GAP],
      [DOC_A, DEST_MAX_SORT_ORDER + 2 * STACK_RANK_GAP],
    ]);
    if (!result.ok) {
      throw new Error(`batchMovePerItem returned ${result.error}`);
    }
    expect(Object.fromEntries(result.value.results)).toEqual({
      [DOC_B]: { id: DOC_B, status: BATCH_ITEM_APPLIED_STATUS },
      [DOC_A]: { id: DOC_A, status: BATCH_ITEM_APPLIED_STATUS },
      [MISSING_DOC]: {
        id: MISSING_DOC,
        status: BatchItemFailureStatus.NotFound,
        code: BatchItemFailureCode.ArtifactsNotFound,
        message: expect.any(String),
      },
    });
    expect(result.value.projectChanges).toEqual([
      {
        artifactId: DOC_A,
        before: SOURCE_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
      {
        artifactId: DOC_B,
        before: SOURCE_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
    ]);
  });

  it("reports a transition only for the ids it wrote, never for every locked row", async () => {
    // The lock read is the one seam where the rows written and the rows
    // reported can diverge. A locked row the write never covered must not
    // reach the activity feed as a move that happened.
    mocks.queryRaw.mockResolvedValue([
      lockedRow(DOC_A, SOURCE_PROJECT_ID),
      lockedRow(DOC_B, SOURCE_PROJECT_ID),
    ]);

    const result = await documentBatchMoveService.batchMovePerItem(
      [DOC_A],
      TARGET_PROJECT_ID,
      ORG_ID
    );

    expect(writtenUpdate().tuples).toEqual([
      [DOC_A, DEST_MAX_SORT_ORDER + STACK_RANK_GAP],
    ]);
    if (!result.ok) {
      throw new Error(`batchMovePerItem returned ${result.error}`);
    }
    expect(result.value.projectChanges).toEqual([
      {
        artifactId: DOC_A,
        before: SOURCE_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
    ]);
  });

  it("refuses a target project that exists in another org, before taking the lock", async () => {
    const result = await documentBatchMoveService.batchMovePerItem(
      [DOC_A],
      FOREIGN_PROJECT_ID,
      ORG_ID
    );

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("refuses a target project that does not exist at all", async () => {
    const result = await documentBatchMoveService.batchMovePerItem(
      [DOC_A],
      UNKNOWN_PROJECT_ID,
      ORG_ID
    );

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("writes nothing when no requested id resolves, and still answers for each", async () => {
    mocks.queryRaw.mockResolvedValue([]);

    const result = await documentBatchMoveService.batchMovePerItem(
      [MISSING_DOC],
      TARGET_PROJECT_ID,
      ORG_ID
    );

    expect(mocks.executeRaw).not.toHaveBeenCalled();
    if (!result.ok) {
      throw new Error(`batchMovePerItem returned ${result.error}`);
    }
    expect(result.value.projectChanges).toEqual([]);
    expect(result.value.results.get(MISSING_DOC)).toMatchObject({
      code: BatchItemFailureCode.ArtifactsNotFound,
    });
  });

  it("opens no transaction for an empty id set", async () => {
    const result = await documentBatchMoveService.batchMovePerItem(
      [],
      TARGET_PROJECT_ID,
      ORG_ID
    );

    expect(mocks.withDb.tx).not.toHaveBeenCalled();
    if (!result.ok) {
      throw new Error(`batchMovePerItem returned ${result.error}`);
    }
    expect([...result.value.results]).toEqual([]);
  });
});

// ISS-12858: a `null` target files the documents into no project and clears
// their rank in one org- and type-scoped `updateMany`; no project is looked up
// and no destination rank is computed.
describe("documentBatchMoveService with a null target (ISS-12858)", () => {
  const clearWrite = {
    where: {
      id: { in: [DOC_B, DOC_A] },
      organizationId: ORG_ID,
      type: ArtifactType.Document,
    },
    data: { projectId: null, sortOrder: null },
  };
  const clearedTransitions = [
    { artifactId: DOC_A, before: SOURCE_PROJECT_ID, after: null },
    { artifactId: DOC_B, before: TARGET_PROJECT_ID, after: null },
  ];

  beforeEach(() => {
    mocks.queryRaw.mockResolvedValue([
      lockedRow(DOC_A, SOURCE_PROJECT_ID),
      lockedRow(DOC_B, TARGET_PROJECT_ID),
    ]);
  });

  it("batchMove clears project and rank for every requested id", async () => {
    const result = await documentBatchMoveService.batchMove(
      [DOC_B, DOC_A],
      null,
      ORG_ID
    );

    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.aggregate).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith(clearWrite);
    if (!result.ok) {
      throw new Error(`batchMove returned ${result.error}`);
    }
    expect(result.value.projectChanges).toEqual(clearedTransitions);
  });

  it("batchMovePerItem clears project and rank for every found id", async () => {
    const result = await documentBatchMoveService.batchMovePerItem(
      [DOC_B, DOC_A],
      null,
      ORG_ID
    );

    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith(clearWrite);
    if (!result.ok) {
      throw new Error(`batchMovePerItem returned ${result.error}`);
    }
    expect(result.value.projectChanges).toEqual(clearedTransitions);
  });
});
