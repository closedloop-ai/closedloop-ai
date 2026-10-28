/**
 * The per-item tag-apply service (ISS-9464).
 *
 * The tag read, the scope read and the insert are ONE transaction over rows
 * locked `FOR KEY SHARE`, so the double below is a transaction client and each
 * case reads the statements the service actually sent. The org predicate is
 * decided from the values each statement binds rather than asserted from an
 * argument list: dropping `organization_id` from either lock leaves the fake
 * with no org to match and reds the mixed case.
 */
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
} from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import { TagEntityType } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMany: vi.fn(),
  queryRaw: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
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

const labelReconciliation = vi.hoisted(() => ({
  reconcileLinkedPullRequestLabelsForArtifacts: vi.fn(),
}));

vi.mock(
  "@/lib/github/artifact-tag-label-reconciliation",
  () => labelReconciliation
);

import { batchApplyTagService } from "@/app/tags/batch-apply-tag-service";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "11111111-1111-4111-8111-111111111112";
const TAG_ID = "33333333-3333-4333-8333-333333333331";
const ARTIFACT_A = "55555555-5555-4555-8555-555555555551";
const ARTIFACT_B = "55555555-5555-4555-8555-555555555552";
/** Belongs to OTHER_ORG_ID. */
const FOREIGN_ARTIFACT = "55555555-5555-4555-8555-555555555553";
/** Exists in no org. */
const DELETED_ARTIFACT = "55555555-5555-4555-8555-555555555554";

/** What each step appends to {@link steps}, in the order it ran. */
const LOCK_TAG = "lock:tags";
const LOCK_ARTIFACTS = "lock:artifacts";
const INSERT = "insert:tag_artifacts";
const COMMIT = "tx:commit";
const RECONCILE = "reconcile:labels";

type FakeSql = { sql: string; values: unknown[] };

const rows = {
  artifacts: new Map<string, string>(),
  tags: new Map<string, string>(),
  /** Artifact ids that already carry {@link TAG_ID}. */
  tagged: new Set<string>(),
};

let steps: string[] = [];

function applied(id: string) {
  return { id, status: BATCH_ITEM_APPLIED_STATUS };
}

function notFound(id: string) {
  return {
    id,
    status: BatchItemFailureStatus.NotFound,
    code: BatchItemFailureCode.ArtifactsNotFound,
    message: expect.any(String),
  };
}

function applyPerItem(entityIds: string[]) {
  return batchApplyTagService.applyPerItem(
    TAG_ID,
    TagEntityType.Artifact,
    entityIds,
    ORG_ID
  );
}

async function itemsById(entityIds: string[]) {
  const result = await applyPerItem(entityIds);
  if (!result.ok) {
    throw new Error(`applyPerItem returned an envelope error ${result.error}`);
  }
  return Object.fromEntries(result.value.results);
}

/** The statement each lock sent, read off the rendered `Prisma.sql` fake. */
function lockStatements() {
  return mocks.queryRaw.mock.calls.map(([statement]) => statement as FakeSql);
}

beforeEach(() => {
  vi.clearAllMocks();
  steps = [];
  rows.artifacts = new Map([
    [ARTIFACT_A, ORG_ID],
    [ARTIFACT_B, ORG_ID],
    [FOREIGN_ARTIFACT, OTHER_ORG_ID],
  ]);
  rows.tags = new Map([[TAG_ID, ORG_ID]]);
  rows.tagged = new Set();
  mocks.createMany.mockImplementation(
    ({ data }: { data: { artifactId: string }[] }) => {
      steps.push(INSERT);
      // `ON CONFLICT DO NOTHING ... RETURNING`: a row that already carried the
      // tag is skipped and therefore NOT returned, which is exactly what makes
      // the returned set the receipt's scope (ISS-9465 ruling 1).
      return Promise.resolve(
        data
          .filter((row) => !rows.tagged.has(row.artifactId))
          .map((row) => ({ artifactId: row.artifactId }))
      );
    }
  );
  labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts.mockImplementation(
    () => {
      steps.push(RECONCILE);
      return Promise.resolve();
    }
  );
  mocks.queryRaw.mockImplementation((statement: FakeSql) => {
    if (statement.sql.includes('FROM "tags"')) {
      steps.push(LOCK_TAG);
      const [tagId, organizationId] = statement.values as [string, string];
      return Promise.resolve(
        rows.tags.get(tagId) === organizationId ? [{ id: tagId }] : []
      );
    }
    steps.push(LOCK_ARTIFACTS);
    const [joined, organizationId] = statement.values as [FakeSql, string];
    const requestedIds = (joined.values as FakeSql[]).map(
      (row) => row.values[0] as string
    );
    // Sorted, as `ORDER BY "id" ASC` returns them: a service that reported or
    // wrote in lock order rather than request order fails the cases below.
    return Promise.resolve(
      requestedIds
        .filter((id) => rows.artifacts.get(id) === organizationId)
        .sort()
        .map((id) => ({ id }))
    );
  });
  mocks.withDb.tx.mockImplementation(
    async (handler: (tx: unknown) => Promise<unknown>) => {
      const result = await handler({
        $queryRaw: mocks.queryRaw,
        tagArtifact: { createManyAndReturn: mocks.createMany },
      });
      steps.push(COMMIT);
      return result;
    }
  );
});

describe("batchApplyTagService.applyPerItem (ISS-9464)", () => {
  it("tags only the ids that resolve in the caller's org and reports the rest not found", async () => {
    const items = await itemsById([
      ARTIFACT_B,
      FOREIGN_ARTIFACT,
      ARTIFACT_A,
      DELETED_ARTIFACT,
      ARTIFACT_B,
    ]);

    expect(items).toEqual({
      [ARTIFACT_B]: applied(ARTIFACT_B),
      [ARTIFACT_A]: applied(ARTIFACT_A),
      [FOREIGN_ARTIFACT]: notFound(FOREIGN_ARTIFACT),
      [DELETED_ARTIFACT]: notFound(DELETED_ARTIFACT),
    });
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [
        { tagId: TAG_ID, artifactId: ARTIFACT_B },
        { tagId: TAG_ID, artifactId: ARTIFACT_A },
      ],
      skipDuplicates: true,
      select: { artifactId: true },
    });
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      artifactIds: [ARTIFACT_B, ARTIFACT_A],
    });
  });

  it("decides and writes inside ONE transaction, and reconciles labels only after it commits", async () => {
    await itemsById([ARTIFACT_A, DELETED_ARTIFACT]);

    // There is no separate read of `tag_artifacts` to order: the insert itself
    // RETURNS the rows it wrote, so the receipt's scope cannot be computed
    // against a snapshot the insert then disagrees with (ISS-9465 ruling 1).
    expect(steps).toEqual([
      LOCK_TAG,
      LOCK_ARTIFACTS,
      INSERT,
      COMMIT,
      RECONCILE,
    ]);
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    // The pooled client, un-transacted: a round-trip issued through it is a
    // read or write outside the lock the batch is decided under.
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("locks both the tag row and the artifact scope against deletion, in id order", async () => {
    await itemsById([ARTIFACT_B, ARTIFACT_A]);

    const [tagLock, artifactLock] = lockStatements();
    expect(tagLock.sql).toContain("FOR KEY SHARE");
    expect(artifactLock.sql).toContain("FOR KEY SHARE");
    expect(artifactLock.sql).toContain('ORDER BY "id" ASC');
  });

  it("refuses a tag outside the caller's org without reading or writing artifacts", async () => {
    rows.tags.set(TAG_ID, OTHER_ORG_ID);

    await expect(applyPerItem([ARTIFACT_A])).resolves.toEqual({
      ok: false,
      error: Status.NotFound,
    });
    expect(steps).toEqual([LOCK_TAG, COMMIT]);
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).not.toHaveBeenCalled();
  });

  it("skips the write and the label reconciliation when no requested id resolves", async () => {
    const items = await itemsById([FOREIGN_ARTIFACT, DELETED_ARTIFACT]);

    expect(items).toEqual({
      [FOREIGN_ARTIFACT]: notFound(FOREIGN_ARTIFACT),
      [DELETED_ARTIFACT]: notFound(DELETED_ARTIFACT),
    });
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).not.toHaveBeenCalled();
  });

  it("reports only the ids that GAINED the tag, not every applied id", async () => {
    rows.tagged = new Set([ARTIFACT_A]);

    const result = await applyPerItem([ARTIFACT_A, ARTIFACT_B]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Both are `applied`, and one of them changed nothing. A count cannot tell
    // them apart, which is why ruling 1 takes the ids the insert RETURNED.
    expect(Object.fromEntries(result.value.results)).toEqual({
      [ARTIFACT_A]: applied(ARTIFACT_A),
      [ARTIFACT_B]: applied(ARTIFACT_B),
    });
    expect(result.value.newlyTaggedIds).toEqual([ARTIFACT_B]);
    // Reconciliation covers both applied ids so a retry repairs a missing
    // provider label even when the database membership already existed.
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      artifactIds: [ARTIFACT_A, ARTIFACT_B],
    });
  });

  it("reconciles GitHub labels when every requested tag already exists", async () => {
    rows.tagged = new Set([ARTIFACT_A, ARTIFACT_B]);

    const result = await applyPerItem([ARTIFACT_A, ARTIFACT_B]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.newlyTaggedIds).toEqual([]);
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      artifactIds: [ARTIFACT_A, ARTIFACT_B],
    });
  });
});
