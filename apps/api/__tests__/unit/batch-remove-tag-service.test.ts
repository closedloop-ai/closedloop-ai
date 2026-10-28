/**
 * The per-item tag-REMOVE service (ISS-10686).
 *
 * The tag lock, the scope lock and the delete are ONE transaction over rows
 * locked `FOR KEY SHARE`, so the double below is a transaction client and each
 * case reads the statements the service actually sent. The org predicate is
 * decided from the values each statement binds rather than asserted from an
 * argument list: dropping `organization_id` from either lock leaves the fake
 * with no org to match, so the refusal case below reports a success instead.
 *
 * The fake's tag store is per-artifact SETS of tag ids, not a flat "is tagged"
 * flag. That is what lets the cases assert the delete is tag-SCOPED — a
 * predicate that dropped `tag_id` would still pass a boolean fake.
 */
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemAppliedOutcome,
} from "@repo/api/src/types/batch-mutation-result";
import { TagEntityType } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  logError: vi.fn(),
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

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const labelReconciliation = vi.hoisted(() => ({
  reconcileLinkedPullRequestLabelsForArtifacts: vi.fn(),
}));

vi.mock(
  "@/lib/github/artifact-tag-label-reconciliation",
  () => labelReconciliation
);

import {
  BatchRemoveTagRefusal,
  batchRemoveTagService,
} from "@/app/tags/batch-remove-tag-service";
import {
  BATCH_TAG_REMOVE_UNRESOLVED_IDS_EVENT,
  batchTagRemoveUnresolvedIdsThrottle,
} from "@/app/tags/batch-tag-removal-telemetry";
import { FIXED_WINDOW_EMISSION_WINDOW_MS } from "@/lib/observability/fixed-window-emission-throttle";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "11111111-1111-4111-8111-111111111112";
const TAG_ID = "33333333-3333-4333-8333-333333333331";
/** A second tag on the same artifacts; the delete must leave it alone. */
const OTHER_TAG_ID = "33333333-3333-4333-8333-333333333332";
const CARRYING_A = "55555555-5555-4555-8555-555555555551";
const CARRYING_B = "55555555-5555-4555-8555-555555555552";
const BARE_C = "55555555-5555-4555-8555-555555555553";
const BARE_D = "55555555-5555-4555-8555-555555555554";
/** Belongs to OTHER_ORG_ID. */
const FOREIGN_ARTIFACT = "55555555-5555-4555-8555-555555555555";
/** Exists in no org. */
const DELETED_ARTIFACT = "55555555-5555-4555-8555-555555555556";
const MIXED_CASE_ARTIFACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const LOCK_TAG = "lock:tags";
const LOCK_ARTIFACTS = "lock:artifacts";
const DELETE = "delete:tag_artifacts";
const COMMIT = "tx:commit";
const RECONCILE = "reconcile:labels";

type FakeSql = { sql: string; values: unknown[] };

const rows = {
  artifacts: new Map<string, string>(),
  tags: new Map<string, string>(),
  /** artifact id → the tag ids it carries. */
  tagged: new Map<string, Set<string>>(),
};

let steps: string[] = [];

function changed(id: string) {
  return {
    id,
    status: BATCH_ITEM_APPLIED_STATUS,
    outcome: BatchItemAppliedOutcome.Removed,
  };
}

function unchanged(id: string) {
  return {
    id,
    status: BATCH_ITEM_APPLIED_STATUS,
    outcome: BatchItemAppliedOutcome.NotPresent,
  };
}

function removePerItem(entityIds: string[]) {
  return batchRemoveTagService.removePerItem(
    TAG_ID,
    TagEntityType.Artifact,
    entityIds,
    ORG_ID
  );
}

async function okResult(entityIds: string[]) {
  const result = await removePerItem(entityIds);
  if (!result.ok) {
    throw new Error(`removePerItem was refused: ${result.error}`);
  }
  return result.value;
}

/** Which artifacts still carry {@link TAG_ID} in the fake store. */
function stillCarryingTag(): string[] {
  return [...rows.tagged.entries()]
    .filter(([, tagIds]) => tagIds.has(TAG_ID))
    .map(([artifactId]) => artifactId)
    .sort();
}

function statements() {
  return mocks.queryRaw.mock.calls.map(([statement]) => statement as FakeSql);
}

/** The event names the production alarm path actually logged. */
function alarmEvents(): string[] {
  return mocks.logError.mock.calls.map(([event]) => event as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  // A module-level fixed-window throttle outlives a single case: without this a
  // second refusal in the same window is suppressed and the alarm assertion
  // passes or fails on file order.
  batchTagRemoveUnresolvedIdsThrottle.clear();
  steps = [];
  rows.artifacts = new Map([
    [CARRYING_A, ORG_ID],
    [CARRYING_B, ORG_ID],
    [BARE_C, ORG_ID],
    [BARE_D, ORG_ID],
    [FOREIGN_ARTIFACT, OTHER_ORG_ID],
  ]);
  rows.tags = new Map([[TAG_ID, ORG_ID]]);
  rows.tagged = new Map([
    [CARRYING_A, new Set([TAG_ID, OTHER_TAG_ID])],
    [CARRYING_B, new Set([TAG_ID])],
    [BARE_C, new Set([OTHER_TAG_ID])],
    [BARE_D, new Set<string>()],
  ]);
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
    if (statement.sql.includes('DELETE FROM "tag_artifacts"')) {
      steps.push(DELETE);
      const [tagId, joined] = statement.values as [string, FakeSql];
      const requestedIds = (joined.values as FakeSql[]).map(
        (row) => row.values[0] as string
      );
      // `DELETE ... RETURNING`: only a row that was really there comes back,
      // which is what makes the returned set the receipt's scope. Scoped by
      // `tag_id` too, so a sibling tag on the same artifact survives.
      const removed = requestedIds.filter((id) =>
        rows.tagged.get(id)?.delete(tagId)
      );
      return Promise.resolve(removed.map((id) => ({ artifactId: id })));
    }
    steps.push(LOCK_ARTIFACTS);
    const [joined, organizationId] = statement.values as [FakeSql, string];
    const requestedIds = (joined.values as FakeSql[]).map(
      (row) => row.values[0] as string
    );
    // Sorted, as `ORDER BY "id" ASC` returns them: a service that reported in
    // lock order rather than request order fails the cases below.
    return Promise.resolve(
      requestedIds
        .filter((id) => rows.artifacts.get(id) === organizationId)
        .sort()
        .map((id) => ({ id }))
    );
  });
  mocks.withDb.tx.mockImplementation(
    async (handler: (tx: unknown) => Promise<unknown>) => {
      const result = await handler({ $queryRaw: mocks.queryRaw });
      steps.push(COMMIT);
      return result;
    }
  );
});

describe("batchRemoveTagService.removePerItem (ISS-10686)", () => {
  it("reports removed and not-present apart, and leaves the untouched rows tagged", async () => {
    // The ruling this case exists to protect: a mixed batch is all success, and
    // the two outcomes stay distinguishable. A shape that collapsed them would
    // let a caller report 4 removals when it performed 2.
    const value = await okResult([CARRYING_B, BARE_C, CARRYING_A, BARE_D]);
    const items = Object.fromEntries(value.results);

    expect(items).toEqual({
      [CARRYING_B]: changed(CARRYING_B),
      [BARE_C]: unchanged(BARE_C),
      [CARRYING_A]: changed(CARRYING_A),
      [BARE_D]: unchanged(BARE_D),
    });
    const outcomes = [...value.results.values()].map(
      (item) => "outcome" in item && item.outcome
    );
    expect(
      outcomes.filter((outcome) => outcome === BatchItemAppliedOutcome.Removed)
    ).toHaveLength(2);
    expect(
      outcomes.filter(
        (outcome) => outcome === BatchItemAppliedOutcome.NotPresent
      )
    ).toHaveLength(2);
    expect(value.removedIds.slice().sort()).toEqual(
      [CARRYING_A, CARRYING_B].sort()
    );
    // The negative half of the same fact, read off the store rather than the
    // response: the two artifacts that did not carry the tag still do not, and
    // CARRYING_A's OTHER tag survived a delete scoped to this one.
    expect(stillCarryingTag()).toEqual([]);
    expect([...(rows.tagged.get(CARRYING_A) ?? [])]).toEqual([OTHER_TAG_ID]);
    expect([...(rows.tagged.get(BARE_C) ?? [])]).toEqual([OTHER_TAG_ID]);
  });

  it("collapses a duplicate id into one result and one delete", async () => {
    const value = await okResult([CARRYING_A, CARRYING_A, BARE_C]);

    expect([...value.results.keys()]).toEqual([CARRYING_A, BARE_C]);
    expect(value.removedIds).toEqual([CARRYING_A]);
    expect(steps.filter((step) => step === DELETE)).toHaveLength(1);
  });

  it("normalizes UUID case before dedupe, matching, and outcome classification", async () => {
    rows.artifacts.set(MIXED_CASE_ARTIFACT, ORG_ID);
    rows.tagged.set(MIXED_CASE_ARTIFACT, new Set([TAG_ID]));

    const value = await okResult([
      MIXED_CASE_ARTIFACT.toUpperCase(),
      MIXED_CASE_ARTIFACT,
    ]);

    expect([...value.results]).toEqual([
      [MIXED_CASE_ARTIFACT, changed(MIXED_CASE_ARTIFACT)],
    ]);
    expect(value.removedIds).toEqual([MIXED_CASE_ARTIFACT]);
    expect(steps.filter((step) => step === DELETE)).toHaveLength(1);
  });

  it("refuses the whole batch and raises the alarm when an id is not in the caller's org", async () => {
    // R11. The org predicate lives in the artifact lock, so this is the case
    // that reds if `organization_id` leaves it: FOREIGN_ARTIFACT would resolve
    // and the batch would commit.
    await expect(
      removePerItem([CARRYING_A, FOREIGN_ARTIFACT, CARRYING_B])
    ).resolves.toEqual({
      ok: false,
      error: BatchRemoveTagRefusal.UnresolvedIds,
    });

    expect(alarmEvents()).toEqual([BATCH_TAG_REMOVE_UNRESOLVED_IDS_EVENT]);
    expect(mocks.logError).toHaveBeenCalledWith(
      BATCH_TAG_REMOVE_UNRESOLVED_IDS_EVENT,
      expect.objectContaining({
        organizationId: ORG_ID,
        unresolvedIdCount: 1,
        requestedIdCount: 3,
      })
    );
    await expect(
      removePerItem([CARRYING_A, FOREIGN_ARTIFACT, CARRYING_B])
    ).resolves.toEqual({
      ok: false,
      error: BatchRemoveTagRefusal.UnresolvedIds,
    });
    expect(alarmEvents()).toEqual([BATCH_TAG_REMOVE_UNRESOLVED_IDS_EVENT]);
    batchTagRemoveUnresolvedIdsThrottle.drainExpired(
      Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS * 2
    );
    expect(mocks.logError).toHaveBeenNthCalledWith(
      2,
      BATCH_TAG_REMOVE_UNRESOLVED_IDS_EVENT,
      expect.objectContaining({
        aggregated: true,
        flushedBy: "expiry",
        occurrences: 1,
        organizationId: ORG_ID,
      })
    );
    // Writes NOTHING: no delete statement, and the tag still on both artifacts
    // the caller was entitled to.
    expect(steps).toEqual([
      LOCK_TAG,
      LOCK_ARTIFACTS,
      COMMIT,
      LOCK_TAG,
      LOCK_ARTIFACTS,
      COMMIT,
    ]);
    expect(stillCarryingTag()).toEqual([CARRYING_A, CARRYING_B].sort());
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).not.toHaveBeenCalled();
  });

  it("refuses an id that exists in no org at all, without naming it", async () => {
    await expect(
      removePerItem([CARRYING_A, DELETED_ARTIFACT])
    ).resolves.toEqual({
      ok: false,
      error: BatchRemoveTagRefusal.UnresolvedIds,
    });

    // The alarm carries counts and the org, never the ids: an org-scoped read
    // cannot tell "absent everywhere" from "present where the caller cannot
    // see", and echoing the ids back is the enumeration oracle R11 refuses.
    const [, fields] = mocks.logError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.values(fields)).not.toContain(DELETED_ARTIFACT);
    // Nothing was written: CARRYING_A was in the refused batch and still carries
    // the tag, and CARRYING_B, which the batch never named, is untouched.
    expect(stillCarryingTag()).toEqual([CARRYING_A, CARRYING_B].sort());
  });

  it("removes the tag from every id when they all resolve in the caller's org", async () => {
    // The positive sibling of the two refusals above: the same service, the same
    // locks, one id fewer. A handler that refused everything would pass those
    // two cases and fail this one.
    const value = await okResult([CARRYING_A, CARRYING_B]);

    expect(value.removedIds).toEqual([CARRYING_A, CARRYING_B]);
    expect(stillCarryingTag()).toEqual([]);
    expect(alarmEvents()).toEqual([]);
  });

  it("refuses a tag outside the caller's org without reading or writing artifacts", async () => {
    rows.tags.set(TAG_ID, OTHER_ORG_ID);

    await expect(removePerItem([CARRYING_A])).resolves.toEqual({
      ok: false,
      error: BatchRemoveTagRefusal.TagNotFound,
    });
    expect(steps).toEqual([LOCK_TAG, COMMIT]);
    expect(stillCarryingTag()).toEqual([CARRYING_A, CARRYING_B].sort());
    // Not the R11 case: the tag is the caller's own mistake about one id it
    // named, not an unresolvable member of the selection.
    expect(alarmEvents()).toEqual([]);
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).not.toHaveBeenCalled();
  });

  it("decides and deletes inside ONE transaction, and reconciles labels only after it commits", async () => {
    await okResult([CARRYING_A, BARE_C]);

    expect(steps).toEqual([
      LOCK_TAG,
      LOCK_ARTIFACTS,
      DELETE,
      COMMIT,
      RECONCILE,
    ]);
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    // The pooled client, un-transacted: a round-trip issued through it is a read
    // or write outside the lock the batch is decided under.
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("records the receipt in the same transaction using only memberships actually removed", async () => {
    const receipt = vi.fn(() => {
      steps.push("receipt:activity");
      return Promise.resolve();
    });

    const result = await batchRemoveTagService.removePerItem(
      TAG_ID,
      TagEntityType.Artifact,
      [CARRYING_A, BARE_C],
      ORG_ID,
      receipt
    );

    expect(result.ok).toBe(true);
    expect(receipt).toHaveBeenCalledWith(
      expect.objectContaining({ $queryRaw: mocks.queryRaw }),
      [CARRYING_A],
      [CARRYING_A, BARE_C]
    );
    expect(steps).toEqual([
      LOCK_TAG,
      LOCK_ARTIFACTS,
      DELETE,
      "receipt:activity",
      COMMIT,
      RECONCILE,
    ]);
  });

  it("locks both the tag row and the artifact scope against deletion, in id order", async () => {
    await okResult([CARRYING_B, CARRYING_A]);

    const [tagLock, artifactLock] = statements();
    expect(tagLock.sql).toContain("FOR KEY SHARE");
    expect(artifactLock.sql).toContain("FOR KEY SHARE");
    expect(artifactLock.sql).toContain('ORDER BY "id" ASC');
  });

  it("reconciles linked PR labels once, over only memberships actually removed", async () => {
    await okResult([CARRYING_A, BARE_C]);

    // ONE bounded call, as apply makes: a per-artifact removal would fan a
    // 500-id batch out into 500 GitHub write paths (ISS-4760).
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).toHaveBeenCalledTimes(1);
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      artifactIds: [CARRYING_A],
    });
  });

  it("skips linked PR label reconciliation when every membership was already absent", async () => {
    await okResult([BARE_C, BARE_D]);

    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifacts
    ).not.toHaveBeenCalled();
  });

  it("deletes in ONE statement scoped to the tag and the requested ids", async () => {
    await okResult([CARRYING_A, CARRYING_B]);

    const deleteStatement = statements().find((statement) =>
      statement.sql.includes('DELETE FROM "tag_artifacts"')
    );
    expect(deleteStatement?.sql).toContain('RETURNING "artifact_id"');
    expect(deleteStatement?.sql).toContain('"tag_id" = ');
    expect(deleteStatement?.values[0]).toBe(TAG_ID);
  });
});
