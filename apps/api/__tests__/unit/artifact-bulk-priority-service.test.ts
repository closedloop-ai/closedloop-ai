/**
 * The bulk priority write's own logic, with the database faked: the route test
 * mocks this service away, so without these the id validation, the changedIds
 * split and the prior-value capture had no coverage at all.
 *
 * WHY THE FAKE EVALUATES `where` (ISS-9094 review). An earlier version stubbed
 * `findMany` with a fixed resolved value, so it ignored the predicate entirely
 * — removing `organizationId` from the service would still have passed every
 * test. This fake holds rows for TWO organizations and filters them the way
 * Prisma would, which makes the tenancy scoping load-bearing: the cross-org
 * case below fails if that clause is dropped.
 *
 * ISS-9440 moved the deciding read onto `$queryRaw` so it can take a row lock,
 * so the fake now evaluates that statement's BIND VALUES instead — positionally,
 * in the order `lockArtifactPriorityRows` fixes them (the id list, then the
 * organization, then the artifact type). That keeps every clause load-bearing:
 * drop any one of the three and this fake stops matching rows at all, and the
 * whole file goes red rather than one case.
 */
import { randomUUID } from "node:crypto";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { Priority } from "@repo/api/src/types/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = vi.hoisted(() => {
  type Row = {
    id: string;
    organizationId: string;
    type: string;
    priority: string | null;
  };
  /** One bind value of the locked read: a joined id list, or a scalar. */
  type Bind = { joined: { values: string[] }[] } | string;
  type Where = {
    type?: string;
    organizationId?: string;
    id?: string | { in?: string[] };
    /**
     * ISS-9440: the fake EVALUATES this, which is what makes the optimistic
     * guard load-bearing here. A fake that ignored it would write the row
     * regardless and every guard assertion below would pass with the predicate
     * deleted. `null` is a real value to match (SQL `IS NULL`), not "absent".
     */
    priority?: string | null;
  };

  const state = {
    rows: [] as Row[],
    lockedReadCalls: 0,
    lastLockSql: "",
  };

  function matches(row: Row, where: Where): boolean {
    if (where.type !== undefined && row.type !== where.type) {
      return false;
    }
    if (
      where.organizationId !== undefined &&
      row.organizationId !== where.organizationId
    ) {
      return false;
    }
    if (typeof where.id === "string" && row.id !== where.id) {
      return false;
    }
    if (
      where.id &&
      typeof where.id === "object" &&
      where.id.in &&
      !where.id.in.includes(row.id)
    ) {
      return false;
    }
    if (
      Object.hasOwn(where, "priority") &&
      row.priority !== (where.priority ?? null)
    ) {
      return false;
    }
    return true;
  }

  function lockedRead(query: { sql: string; values: Bind[] }) {
    state.lockedReadCalls += 1;
    state.lastLockSql = query.sql;
    const [idList, organizationId, type] = query.values;
    const ids =
      typeof idList === "string"
        ? []
        : idList.joined.map((node) => node.values[0]);
    return Promise.resolve(
      state.rows
        .filter(
          (row) =>
            ids.includes(row.id) &&
            row.organizationId === organizationId &&
            row.type === type
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => ({ id: row.id, priority: row.priority }))
    );
  }

  const artifact = {
    updateMany({ where, data }: { where: Where; data: { priority: string } }) {
      const hits = state.rows.filter((row) => matches(row, where));
      for (const row of hits) {
        row.priority = data.priority;
      }
      return Promise.resolve({ count: hits.length });
    },
  };

  const client = { artifact, $queryRaw: lockedRead };

  return {
    state,
    withDb: Object.assign(
      vi.fn((fn: (db: typeof client) => unknown) => fn(client)),
      { tx: vi.fn((fn: (tx: typeof client) => unknown) => fn(client)) }
    ),
  };
});

vi.mock("@repo/database", () => ({
  // `documentWhere` reads this to pin the artifact type.
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  Prisma: {
    join: (items: { values: string[] }[]) => ({ joined: items }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join("?"),
      values,
    }),
  },
  withDb: DB.withDb,
}));

import { artifactBulkPriorityService } from "@/app/documents/artifact-bulk-priority-service";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const ID_A = randomUUID();
const ID_B = randomUUID();
const ID_OTHER_ORG = randomUUID();

function priorityOf(id: string): string | null | undefined {
  return DB.state.rows.find((row) => row.id === id)?.priority;
}

describe("artifactBulkPriorityService.batchUpdatePriority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    DB.state.lockedReadCalls = 0;
    DB.state.lastLockSql = "";
    DB.state.rows = [
      {
        id: ID_A,
        organizationId: ORG,
        type: "DOCUMENT",
        priority: Priority.Low,
      },
      {
        id: ID_B,
        organizationId: ORG,
        type: "DOCUMENT",
        priority: Priority.Urgent,
      },
      {
        id: ID_OTHER_ORG,
        organizationId: OTHER_ORG,
        type: "DOCUMENT",
        priority: Priority.Low,
      },
    ];
  });

  it("fails without writing when an id is not in the organization", async () => {
    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, randomUUID()],
      Priority.Urgent,
      ORG
    );

    expect(result.ok).toBe(false);
    expect(priorityOf(ID_A)).toBe(Priority.Low);
  });

  // The tenancy guard, and the reason this fake evaluates `where`: the id is a
  // real artifact, just someone else's. Dropping `organizationId` from the
  // service's predicate turns this from a 400 into a cross-tenant write.
  it("treats an artifact in another organization as missing, and leaves it alone", async () => {
    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_OTHER_ORG],
      Priority.Urgent,
      ORG
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
      expect(result.error.message).toContain(ID_OTHER_ORG);
    }
    expect(priorityOf(ID_OTHER_ORG)).toBe(Priority.Low);
    expect(priorityOf(ID_A)).toBe(Priority.Low);
  });

  it("writes only the rows whose priority actually moves", async () => {
    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_B],
      Priority.Urgent,
      ORG
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changedIds).toEqual([ID_A]);
      expect(result.value.updatedIds).toEqual([ID_A, ID_B]);
    }
    expect(priorityOf(ID_A)).toBe(Priority.Urgent);
  });

  it("issues no write when every row is already at the target", async () => {
    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_B],
      Priority.Urgent,
      ORG
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changedIds).toEqual([]);
      expect(result.value.beforePriorities.size).toBe(0);
    }
  });

  // The defect the removed `getPrioritiesByIds` snapshot used to guard: losing
  // the null made a first-time priority set indistinguishable from an artifact
  // that does not exist, so the feed recorded nothing for it.
  it("reports an unset prior priority as a present key holding null", async () => {
    DB.state.rows = [
      { id: ID_A, organizationId: ORG, type: "DOCUMENT", priority: null },
    ];

    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A],
      Priority.Urgent,
      ORG
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.beforePriorities.has(ID_A)).toBe(true);
      expect(result.value.beforePriorities.get(ID_A)).toBeNull();
    }
  });

  it("reports each changed row's prior priority", async () => {
    DB.state.rows = [
      { id: ID_A, organizationId: ORG, type: "DOCUMENT", priority: null },
      {
        id: ID_B,
        organizationId: ORG,
        type: "DOCUMENT",
        priority: Priority.Low,
      },
    ];

    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_B],
      Priority.High,
      ORG
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.value.beforePriorities]).toEqual([
        [ID_A, null],
        [ID_B, Priority.Low],
      ]);
    }
  });

  // ISS-9094 review (davetho): the prior values must come from the SAME read
  // that decides `changedIds`, inside the write's transaction. Snapshotting
  // them in a second read — as the route used to — lets an update commit in
  // between and makes the activity feed state a `before` that was already
  // stale. One read is the structural guarantee, so assert there is one.
  it("reads the rows once, so no second snapshot can skew the prior values", async () => {
    await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_B],
      Priority.Urgent,
      ORG
    );

    expect(DB.state.lockedReadCalls).toBe(1);
  });

  // ISS-9440. This REPLACES the ISS-9094 case that asserted a 409 when a row
  // vanished between the read and the write. That contract is retired, not
  // weakened: the deciding read now holds `FOR NO KEY UPDATE` on every target
  // row, so a concurrent delete blocks until this transaction ends and the
  // window the old case described no longer exists. What has to be asserted
  // instead is that the lock is actually taken, and taken in id order — the
  // canonical order is what stops two concurrent batches over an overlapping
  // selection deadlocking, and it is the same order the status batch uses on
  // this table so the two routes cannot deadlock against each other either.
  it("takes a row lock in id order before deciding anything", async () => {
    await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_B],
      Priority.High,
      ORG
    );

    expect(DB.state.lastLockSql).toContain("FOR NO KEY UPDATE");
    expect(DB.state.lastLockSql).toContain('ORDER BY "id" ASC');
  });

  it("rejects the whole batch when one guarded row already holds a different priority", async () => {
    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_B],
      Priority.High,
      ORG,
      // ID_A genuinely holds LOW; ID_B holds URGENT, so this expectation is
      // wrong and must take ID_A — a row that WOULD have matched — down with it.
      { [ID_A]: Priority.Low, [ID_B]: Priority.Medium }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(409);
      expect(result.error.code).toBe(
        ArtifactPriorityMutationErrorCode.StalePriority
      );
      expect(result.error.details?.stalePriorities).toEqual([
        {
          documentId: ID_B,
          currentPriority: Priority.Urgent,
          expectedPriority: Priority.Medium,
        },
      ]);
    }
    expect(priorityOf(ID_A)).toBe(Priority.Low);
    expect(priorityOf(ID_B)).toBe(Priority.Urgent);
  });

  // `null` is an ASSERTION ("this artifact holds no priority"), not the absence
  // of one. The two cases are asserted together so a fold of null onto
  // "unguarded" fails the second half.
  it("treats a null expectation as a guard on the unset state", async () => {
    DB.state.rows = [
      { id: ID_A, organizationId: ORG, type: "DOCUMENT", priority: null },
      {
        id: ID_B,
        organizationId: ORG,
        type: "DOCUMENT",
        priority: Priority.Low,
      },
    ];

    const honored = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A],
      Priority.High,
      ORG,
      { [ID_A]: null }
    );
    expect(honored.ok).toBe(true);
    expect(priorityOf(ID_A)).toBe(Priority.High);

    const refused = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_B],
      Priority.High,
      ORG,
      { [ID_B]: null }
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.details?.stalePriorities).toEqual([
        {
          documentId: ID_B,
          currentPriority: Priority.Low,
          expectedPriority: null,
        },
      ]);
    }
    expect(priorityOf(ID_B)).toBe(Priority.Low);
  });

  // Version skew, old client -> new server: no map at all is last-write-wins,
  // exactly as before ISS-9440. The sibling case below covers a map that
  // mentions only SOME of the selected ids.
  it("writes unguarded when the caller sends no expectation map", async () => {
    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A],
      Priority.Urgent,
      ORG
    );

    expect(result.ok).toBe(true);
    expect(priorityOf(ID_A)).toBe(Priority.Urgent);
  });

  // ISS-9486 ruling 2: a retry still carries the expectation its first attempt
  // moved the row off. ID_B already holds URGENT, so it is not stale; ID_A's
  // guard is wrong and still takes the batch down.
  it("never refuses a row that already holds the target, and still refuses a stale one", async () => {
    const retried = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_B],
      Priority.Urgent,
      ORG,
      { [ID_B]: Priority.Medium }
    );
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.value.changedIds).toEqual([]);
    }

    const refused = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_B],
      Priority.Urgent,
      ORG,
      { [ID_A]: Priority.High, [ID_B]: Priority.Medium }
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.details?.stalePriorities).toEqual([
        {
          documentId: ID_A,
          currentPriority: Priority.Low,
          expectedPriority: Priority.High,
        },
      ]);
    }
    expect(priorityOf(ID_A)).toBe(Priority.Low);
  });

  it("guards only the ids the map mentions, and writes the rest", async () => {
    const result = await artifactBulkPriorityService.batchUpdatePriority(
      [ID_A, ID_B],
      Priority.High,
      ORG,
      // ID_B is unmentioned: its URGENT value would fail any guard, so it must
      // be written anyway or the omission was not honored.
      { [ID_A]: Priority.Low }
    );

    expect(result.ok).toBe(true);
    expect(priorityOf(ID_A)).toBe(Priority.High);
    expect(priorityOf(ID_B)).toBe(Priority.High);
  });
});
