/**
 * Unit tests for `artifactBulkRankService` (ISS-8999).
 *
 * `@repo/database` is replaced by a small in-memory store that FILTERS on
 * `organizationId` and `projectId` exactly as Postgres would, and whose
 * `withDb.tx` snapshots the store and restores it when the callback throws.
 * Both properties are load-bearing rather than convenience: a mock that
 * returned a fixed row set would pass whether or not the service scoped its
 * reads to the caller's organization, and a mock that could not roll back
 * could not tell an atomic operation from two independent writes.
 *
 * The real-Postgres half of this contract — that the rewritten `sort_order`
 * values themselves roll back — is `artifact-bulk-rank-service.integration.test.ts`.
 */

import { LinkType } from "@repo/api/src/types/artifact";
import {
  BulkRankConflictReason,
  BulkRankMutationSource,
} from "@repo/api/src/types/project-artifact-bulk-rank";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return {
    ArtifactType: actual.ArtifactType,
    // The real `Prisma` namespace: the isolation level this suite asserts on is
    // named from `Prisma.TransactionIsolationLevel`, and the advisory-lock
    // statement it still observes is built with `Prisma.sql` by
    // `lockProjectRank` (now in `document-sort-order.ts`, shared with the
    // single-item move). A stub here would fake away both.
    Prisma: actual.Prisma,
    withDb: createFakeWithDb(),
  };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: { reorder: vi.fn() },
}));

import { ArtifactType, Prisma } from "@repo/database";
import { documentService } from "@/app/documents/document-service";
import { artifactBulkRankService } from "../artifact-bulk-rank-service";
import { STACK_RANK_GAP } from "../document-sort-order";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

type StoredArtifact = {
  id: string;
  organizationId: string;
  projectId: string;
  type: string;
  sortOrder: number | null;
  createdAt: Date;
};

type StoredLink = {
  id: string;
  organizationId: string;
  sourceId: string;
  targetId: string;
  linkType: string;
  createdAt: Date;
};

type StoredRankEvent = {
  organizationId: string;
  projectId: string;
  idempotencyKey: string;
  source: string;
  actorUserId: string | null;
  rankEpoch: string;
  orderedArtifactIds: string[];
};

type Store = {
  artifacts: StoredArtifact[];
  links: StoredLink[];
  rankEvents: StoredRankEvent[];
};

/**
 * The shape a rank epoch must have on the wire. Pinned with an independent
 * literal rather than derived from the service's own length constant, so a
 * change to that constant is a visible contract change here.
 */
const RANK_EPOCH_PATTERN = /^[0-9a-f]{32}$/;

const store: Store = { artifacts: [], links: [], rankEvents: [] };

/** How `readInternalProducesLinks` scopes an edge end to the project. */
type ArtifactEndFilter = { projectId?: string; organizationId?: string };

/**
 * Every statement the service issued against the fake client, in order. The
 * project rank lock is only worth anything if it precedes the read it is
 * protecting, and ordering is not observable from the store's contents.
 */
const statementLog: string[] = [];

/** The SQL text of each `$executeRaw` the service issued, in order. */
const rawQueries: string[] = [];

/** The `isolationLevel` each `withDb.tx` was opened with, in order. */
const txIsolationLevels: (string | undefined)[] = [];

/**
 * Resolve a relation filter the way Postgres resolves the join: look the
 * referenced artifact up and test the filter against ITS columns. Returning
 * `true` for an unmatched end would let a query that dropped its project scope
 * read another project's edges and still look isolated.
 */
function endMatches(
  artifactId: string,
  filter: ArtifactEndFilter | undefined
): boolean {
  if (!filter) {
    return true;
  }
  const artifact = store.artifacts.find((row) => row.id === artifactId);
  if (!artifact) {
    return false;
  }
  return (
    matchesOptional(artifact.projectId, filter.projectId) &&
    matchesOptional(artifact.organizationId, filter.organizationId)
  );
}

/**
 * One-shot hook fired from inside the transaction's second read, i.e. after the
 * replay fast path has already answered "no committed operation" and before the
 * claim insert. That window is the only place a rival commit can make this
 * request lose the claim, so a test that wants that path installs it here.
 */
let onTransactionRead: (() => void) | null = null;

function cloneStore(source: Store): Store {
  return {
    artifacts: source.artifacts.map((row) => ({ ...row })),
    links: source.links.map((row) => ({ ...row })),
    rankEvents: source.rankEvents.map((row) => ({
      ...row,
      orderedArtifactIds: [...row.orderedArtifactIds],
    })),
  };
}

function replaceStore(next: Store): void {
  store.artifacts = next.artifacts;
  store.links = next.links;
  store.rankEvents = next.rankEvents;
}

/**
 * Postgres semantics for an absent predicate: a `where` key the caller never
 * supplied filters NOTHING. Modelling it as `column === undefined` instead
 * would make a query that DROPPED its org filter return zero rows, which reads
 * like isolation and is the opposite of what the database would do.
 */
function matchesOptional<T>(value: T, expected: T | undefined): boolean {
  return expected === undefined || value === expected;
}

function makeClient() {
  return {
    artifact: {
      findMany: ({
        where,
      }: {
        where: { projectId?: string; organizationId?: string };
      }) => {
        statementLog.push("artifact.findMany");
        return Promise.resolve(
          store.artifacts
            .filter(
              (row) =>
                matchesOptional(row.projectId, where.projectId) &&
                matchesOptional(row.organizationId, where.organizationId)
            )
            .map((row) => ({ ...row }))
        );
      },
    },
    artifactLink: {
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          linkType?: string;
          source?: ArtifactEndFilter;
          target?: ArtifactEndFilter;
          sourceId?: unknown;
          targetId?: unknown;
        };
      }) => {
        statementLog.push("artifactLink.findMany");
        // The bind-parameter bound is a property of the QUERY SHAPE, and both
        // shapes return the same rows — so no row assertion can tell them
        // apart. Refusing the id-list shape here is what makes the fix
        // regressible: `sourceId in (…) AND targetId in (…)` carried every
        // artifact in the project twice and could exceed Postgres' 65,535
        // parameters before anything was ranked.
        if (where.sourceId !== undefined || where.targetId !== undefined) {
          throw new Error(
            "readInternalProducesLinks must scope edges by project relation, not by an enumerated id list"
          );
        }
        const hook = onTransactionRead;
        onTransactionRead = null;
        hook?.();
        return Promise.resolve(
          store.links
            .filter(
              (row) =>
                matchesOptional(row.organizationId, where.organizationId) &&
                matchesOptional(row.linkType, where.linkType) &&
                endMatches(row.sourceId, where.source) &&
                endMatches(row.targetId, where.target)
            )
            .map((row) => ({ ...row }))
        );
      },
    },
    $executeRaw: (query: { sql: string }) => {
      statementLog.push("$executeRaw");
      rawQueries.push(query.sql);
      return Promise.resolve(1);
    },
    projectRankEvent: {
      createMany: ({ data }: { data: StoredRankEvent[] }) => {
        let count = 0;
        for (const row of data) {
          const exists = store.rankEvents.some(
            (existing) =>
              existing.organizationId === row.organizationId &&
              existing.projectId === row.projectId &&
              existing.idempotencyKey === row.idempotencyKey
          );
          if (!exists) {
            store.rankEvents.push({ ...row });
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
      findUnique: ({
        where,
      }: {
        where: {
          organizationId_projectId_idempotencyKey: {
            organizationId: string;
            projectId: string;
            idempotencyKey: string;
          };
        };
      }) => {
        const key = where.organizationId_projectId_idempotencyKey;
        const found = store.rankEvents.find(
          (row) =>
            row.organizationId === key.organizationId &&
            row.projectId === key.projectId &&
            row.idempotencyKey === key.idempotencyKey
        );
        return Promise.resolve(
          found
            ? {
                rankEpoch: found.rankEpoch,
                orderedArtifactIds: [...found.orderedArtifactIds],
              }
            : null
        );
      },
    },
  };
}

function createFakeWithDb() {
  const withDbFn = (fn: (db: unknown) => unknown) => fn(makeClient());
  const tx = async (
    fn: (client: unknown) => unknown,
    options?: { isolationLevel?: string }
  ) => {
    txIsolationLevels.push(options?.isolationLevel);
    const snapshot = cloneStore(store);
    try {
      return await fn(makeClient());
    } catch (error) {
      // Model a rollback: every write the callback made is discarded.
      replaceStore(snapshot);
      throw error;
    }
  };
  return Object.assign(withDbFn, { tx });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ORG_A = "00000000-0000-7000-8000-00000000000a";
const ORG_B = "00000000-0000-7000-8000-00000000000b";
const PROJECT_A = "10000000-0000-7000-8000-00000000000a";
const PROJECT_B = "10000000-0000-7000-8000-00000000000b";
const ACTOR_ID = "20000000-0000-7000-8000-000000000001";
const IDEMPOTENCY_KEY = "rank-run-1";

/** Deterministic ids so the tie-break comparisons in the service are stable. */
function artifactId(org: "a" | "b", index: number): string {
  return `3000000${org === "a" ? 0 : 1}-0000-7000-8000-00000000000${index}`;
}

const ORG_A_ROOTS = [
  artifactId("a", 1),
  artifactId("a", 2),
  artifactId("a", 3),
];
const ORG_B_ROOTS = [artifactId("b", 1), artifactId("b", 2)];

function seedArtifact(overrides: Partial<StoredArtifact> & { id: string }) {
  store.artifacts.push({
    organizationId: ORG_A,
    projectId: PROJECT_A,
    type: ArtifactType.DOCUMENT,
    sortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
}

/**
 * Seed BOTH organizations. Org B carries its own project and its own ranked
 * roots, so a test that reads org B and gets nothing is reporting an isolation
 * failure rather than an empty fixture.
 */
function seedBothOrgs(): void {
  ORG_A_ROOTS.forEach((id, index) => {
    seedArtifact({ id, sortOrder: index * STACK_RANK_GAP });
  });
  ORG_B_ROOTS.forEach((id, index) => {
    seedArtifact({
      id,
      organizationId: ORG_B,
      projectId: PROJECT_B,
      sortOrder: index * STACK_RANK_GAP,
    });
  });
}

/** The reorder the production path delegates to, as the fake store sees it. */
function applyReorder(
  projectId: string,
  ids: string[],
  organizationId: string
): Promise<string[]> {
  ids.forEach((id, index) => {
    const row = store.artifacts.find(
      (candidate) =>
        candidate.id === id &&
        candidate.projectId === projectId &&
        candidate.organizationId === organizationId &&
        candidate.type === ArtifactType.DOCUMENT
    );
    if (row) {
      row.sortOrder = index * STACK_RANK_GAP;
    }
  });
  return Promise.resolve(ids);
}

const mockReorder = vi.mocked(documentService.reorder);

async function currentEpoch(
  projectId = PROJECT_A,
  organizationId = ORG_A
): Promise<string> {
  const state = await artifactBulkRankService.getRankState(
    projectId,
    organizationId
  );
  return state.rankEpoch;
}

function bulkRank(input: {
  orderedArtifactIds: string[];
  expectedRankEpoch: string;
  idempotencyKey?: string;
  projectId?: string;
  organizationId?: string;
}) {
  return artifactBulkRankService.bulkRankArtifacts(
    input.projectId ?? PROJECT_A,
    input.organizationId ?? ORG_A,
    {
      orderedArtifactIds: input.orderedArtifactIds,
      expectedRankEpoch: input.expectedRankEpoch,
      source: BulkRankMutationSource.DependencyRank,
      idempotencyKey: input.idempotencyKey ?? IDEMPOTENCY_KEY,
    },
    ACTOR_ID
  );
}

function sortOrdersOf(ids: readonly string[]): (number | null)[] {
  return ids.map(
    (id) => store.artifacts.find((row) => row.id === id)?.sortOrder ?? null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store.artifacts = [];
  store.links = [];
  store.rankEvents = [];
  // Cleared by name: a one-shot hook a prior case installed but never fired
  // would otherwise run inside an unrelated case's transaction.
  onTransactionRead = null;
  statementLog.length = 0;
  rawQueries.length = 0;
  txIsolationLevels.length = 0;
  mockReorder.mockImplementation(applyReorder);
  seedBothOrgs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("artifactBulkRankService.getRankState", () => {
  it("returns the project's roots in stack-rank order with an epoch", async () => {
    const state = await artifactBulkRankService.getRankState(PROJECT_A, ORG_A);

    expect(state.orderedRootIds).toEqual(ORG_A_ROOTS);
    expect(state.rankEpoch).toMatch(RANK_EPOCH_PATTERN);
  });

  it("excludes nested documents and non-DOCUMENT roots from the ranked population", async () => {
    const nested = artifactId("a", 4);
    const branch = artifactId("a", 5);
    seedArtifact({ id: nested, sortOrder: 4 * STACK_RANK_GAP });
    seedArtifact({
      id: branch,
      type: ArtifactType.BRANCH,
      sortOrder: 5 * STACK_RANK_GAP,
    });
    store.links.push({
      id: "link-1",
      organizationId: ORG_A,
      sourceId: ORG_A_ROOTS[0] as string,
      targetId: nested,
      linkType: LinkType.Produces,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const state = await artifactBulkRankService.getRankState(PROJECT_A, ORG_A);

    expect(state.orderedRootIds).toEqual(ORG_A_ROOTS);
  });

  it("does not read another organization's rows for the same project id", async () => {
    // Org B asking for org A's project id must see nothing, while its OWN
    // project still returns its own seeded roots — so an empty answer here
    // cannot be explained by an empty fixture.
    const crossOrg = await artifactBulkRankService.getRankState(
      PROJECT_A,
      ORG_B
    );
    const ownProject = await artifactBulkRankService.getRankState(
      PROJECT_B,
      ORG_B
    );

    expect(crossOrg.orderedRootIds).toEqual([]);
    expect(ownProject.orderedRootIds).toEqual(ORG_B_ROOTS);
  });

  it("reads both halves of the population from one REPEATABLE READ snapshot", async () => {
    // The artifacts and the PRODUCES edges are two statements, so under the
    // default READ COMMITTED they take two snapshots and a create or reparent
    // between them yields a population no committed state ever held. Asserted
    // on the transaction that was opened, because a hybrid read is not
    // observable from the rows this fake store returns.
    await artifactBulkRankService.getRankState(PROJECT_A, ORG_A);

    expect(txIsolationLevels).toEqual([
      Prisma.TransactionIsolationLevel.RepeatableRead,
    ]);
    expect(statementLog).toEqual([
      "artifact.findMany",
      "artifactLink.findMany",
    ]);
  });
});

describe("artifactBulkRankService.bulkRankArtifacts", () => {
  it("commits the requested order and records the bulk rank event", async () => {
    const expectedRankEpoch = await currentEpoch();
    const desired = [
      ORG_A_ROOTS[2],
      ORG_A_ROOTS[0],
      ORG_A_ROOTS[1],
    ] as string[];

    const result = await bulkRank({
      orderedArtifactIds: desired,
      expectedRankEpoch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a committed rank");
    }
    expect(result.value.orderedArtifactIds).toEqual(desired);
    expect(result.value.replayed).toBe(false);
    // Independent literal, not re-derived from STACK_RANK_GAP arithmetic in the
    // service: the three roots land on the grid in the requested order.
    expect(sortOrdersOf(desired)).toEqual([0, 1000, 2000]);
    expect(store.rankEvents).toEqual([
      {
        organizationId: ORG_A,
        projectId: PROJECT_A,
        idempotencyKey: IDEMPOTENCY_KEY,
        source: BulkRankMutationSource.DependencyRank,
        actorUserId: ACTOR_ID,
        rankEpoch: result.value.rankEpoch,
        orderedArtifactIds: desired,
      },
    ]);
  });

  it("returns the committed epoch, which the next request accepts", async () => {
    const first = await bulkRank({
      orderedArtifactIds: [
        ORG_A_ROOTS[2],
        ORG_A_ROOTS[0],
        ORG_A_ROOTS[1],
      ] as string[],
      expectedRankEpoch: await currentEpoch(),
    });
    if (!first.ok) {
      throw new Error("expected a committed rank");
    }

    const second = await bulkRank({
      orderedArtifactIds: ORG_A_ROOTS,
      expectedRankEpoch: first.value.rankEpoch,
      idempotencyKey: "rank-run-2",
    });

    expect(second.ok).toBe(true);
    expect(await currentEpoch()).toBe(
      second.ok ? second.value.rankEpoch : "unreachable"
    );
  });

  it("rejects a stale epoch when the population is unchanged", async () => {
    const result = await bulkRank({
      orderedArtifactIds: ORG_A_ROOTS,
      expectedRankEpoch: "0".repeat(32),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.status).toBe(Status.Conflict);
    expect(result.error.conflict?.reason).toBe(
      BulkRankConflictReason.StaleEpoch
    );
    expect(result.error.conflict?.addedArtifactIds).toEqual([]);
    expect(result.error.conflict?.removedArtifactIds).toEqual([]);
    expect(result.error.conflict?.reparentedArtifactIds).toEqual([]);
    // Nothing was written: no ranks moved and no event was recorded.
    expect(sortOrdersOf(ORG_A_ROOTS)).toEqual([0, 1000, 2000]);
    expect(store.rankEvents).toEqual([]);
    expect(mockReorder).not.toHaveBeenCalled();
  });

  it("reports a root that appeared since the caller read the order", async () => {
    const expectedRankEpoch = await currentEpoch();
    const appeared = artifactId("a", 6);
    seedArtifact({ id: appeared, sortOrder: 6 * STACK_RANK_GAP });

    const result = await bulkRank({
      orderedArtifactIds: ORG_A_ROOTS,
      expectedRankEpoch,
    });

    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.conflict?.reason).toBe(
      BulkRankConflictReason.PopulationMismatch
    );
    expect(result.error.conflict?.addedArtifactIds).toEqual([appeared]);
    expect(mockReorder).not.toHaveBeenCalled();
  });

  it("reports a root that was reparented separately from one that left the project", async () => {
    const expectedRankEpoch = await currentEpoch();
    const reparented = ORG_A_ROOTS[2] as string;
    store.links.push({
      id: "link-2",
      organizationId: ORG_A,
      sourceId: ORG_A_ROOTS[0] as string,
      targetId: reparented,
      linkType: LinkType.Produces,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const result = await bulkRank({
      orderedArtifactIds: [...ORG_A_ROOTS, artifactId("a", 9)],
      expectedRankEpoch,
    });

    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.conflict?.reparentedArtifactIds).toEqual([reparented]);
    expect(result.error.conflict?.removedArtifactIds).toEqual([
      artifactId("a", 9),
    ]);
  });

  it("refuses an id that belongs to another project", async () => {
    const expectedRankEpoch = await currentEpoch();

    const result = await bulkRank({
      orderedArtifactIds: [...ORG_A_ROOTS, ORG_B_ROOTS[0] as string],
      expectedRankEpoch,
    });

    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.conflict?.removedArtifactIds).toEqual([ORG_B_ROOTS[0]]);
    expect(mockReorder).not.toHaveBeenCalled();
    // Org B's ranks are untouched by org A's rejected request.
    expect(sortOrdersOf(ORG_B_ROOTS)).toEqual([0, 1000]);
  });

  it("cannot move another organization's roots even with their exact ids", async () => {
    const orgBEpoch = await currentEpoch(PROJECT_B, ORG_B);

    const result = await bulkRank({
      orderedArtifactIds: [ORG_B_ROOTS[1], ORG_B_ROOTS[0]] as string[],
      expectedRankEpoch: orgBEpoch,
      projectId: PROJECT_B,
      organizationId: ORG_A,
    });

    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.conflict?.removedArtifactIds).toEqual([
      ORG_B_ROOTS[1],
      ORG_B_ROOTS[0],
    ]);
    expect(sortOrdersOf(ORG_B_ROOTS)).toEqual([0, 1000]);
    expect(store.rankEvents).toEqual([]);
  });

  it("moves no rank and records no event when the rewrite fails mid-operation", async () => {
    const expectedRankEpoch = await currentEpoch();
    const desired = [
      ORG_A_ROOTS[2],
      ORG_A_ROOTS[0],
      ORG_A_ROOTS[1],
    ] as string[];
    // The claim insert succeeds first; the rank rewrite then fails. Both are
    // inside one transaction, so neither may survive.
    mockReorder.mockRejectedValueOnce(new Error("rewrite failed"));

    await expect(
      bulkRank({ orderedArtifactIds: desired, expectedRankEpoch })
    ).rejects.toThrow("rewrite failed");

    expect(sortOrdersOf(ORG_A_ROOTS)).toEqual([0, 1000, 2000]);
    expect(store.rankEvents).toEqual([]);
    expect(await currentEpoch()).toBe(expectedRankEpoch);
  });

  it("re-applies after a rolled-back attempt when the same key is retried", async () => {
    const expectedRankEpoch = await currentEpoch();
    const desired = [
      ORG_A_ROOTS[2],
      ORG_A_ROOTS[0],
      ORG_A_ROOTS[1],
    ] as string[];
    mockReorder.mockRejectedValueOnce(new Error("timed out"));
    await expect(
      bulkRank({ orderedArtifactIds: desired, expectedRankEpoch })
    ).rejects.toThrow("timed out");

    const retry = await bulkRank({
      orderedArtifactIds: desired,
      expectedRankEpoch,
    });

    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.value.replayed).toBe(false);
    expect(sortOrdersOf(desired)).toEqual([0, 1000, 2000]);
  });

  it("replays a committed result for a repeated idempotency key without re-ranking", async () => {
    const expectedRankEpoch = await currentEpoch();
    const desired = [
      ORG_A_ROOTS[2],
      ORG_A_ROOTS[0],
      ORG_A_ROOTS[1],
    ] as string[];
    const first = await bulkRank({
      orderedArtifactIds: desired,
      expectedRankEpoch,
    });
    if (!first.ok) {
      throw new Error("expected a committed rank");
    }
    mockReorder.mockClear();

    // The retry still carries the PRE-commit epoch, exactly as a client that
    // never saw the first response would send it.
    const replay = await bulkRank({
      orderedArtifactIds: desired,
      expectedRankEpoch,
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) {
      throw new Error("expected a replay");
    }
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.rankEpoch).toBe(first.value.rankEpoch);
    expect(replay.value.orderedArtifactIds).toEqual(desired);
    expect(mockReorder).not.toHaveBeenCalled();
    expect(store.rankEvents).toHaveLength(1);
  });

  it("replays rather than re-ranking when a concurrent request claims the key first", async () => {
    const expectedRankEpoch = await currentEpoch();
    const desired = [
      ORG_A_ROOTS[2],
      ORG_A_ROOTS[0],
      ORG_A_ROOTS[1],
    ] as string[];
    const rival = [ORG_A_ROOTS[1], ORG_A_ROOTS[2], ORG_A_ROOTS[0]] as string[];
    const rivalEpoch = "f".repeat(32);
    // A rival request holding the same key commits inside this request's own
    // transaction window — after the replay fast path answered "nothing
    // committed" and before the claim insert.
    onTransactionRead = () => {
      store.rankEvents.push({
        organizationId: ORG_A,
        projectId: PROJECT_A,
        idempotencyKey: IDEMPOTENCY_KEY,
        source: BulkRankMutationSource.DependencyRank,
        actorUserId: ACTOR_ID,
        rankEpoch: rivalEpoch,
        orderedArtifactIds: rival,
      });
    };

    const loser = await bulkRank({
      orderedArtifactIds: desired,
      expectedRankEpoch,
    });

    expect(loser.ok).toBe(true);
    if (!loser.ok) {
      throw new Error("expected a replay");
    }
    expect(loser.value.replayed).toBe(true);
    expect(loser.value.rankEpoch).toBe(rivalEpoch);
    expect(loser.value.orderedArtifactIds).toEqual(rival);
    expect(mockReorder).not.toHaveBeenCalled();
    expect(store.rankEvents).toHaveLength(1);
  });

  it("issues one reorder for the whole population, not one per root", async () => {
    const expectedRankEpoch = await currentEpoch();

    await bulkRank({
      orderedArtifactIds: [
        ORG_A_ROOTS[2],
        ORG_A_ROOTS[1],
        ORG_A_ROOTS[0],
      ] as string[],
      expectedRankEpoch,
    });

    expect(mockReorder).toHaveBeenCalledTimes(1);
    expect(mockReorder).toHaveBeenCalledWith(
      PROJECT_A,
      [ORG_A_ROOTS[2], ORG_A_ROOTS[1], ORG_A_ROOTS[0]],
      ORG_A
    );
  });

  it("leaves nested and non-DOCUMENT artifacts unranked", async () => {
    const nested = artifactId("a", 4);
    const branch = artifactId("a", 5);
    seedArtifact({ id: nested, sortOrder: 77 });
    seedArtifact({ id: branch, type: ArtifactType.BRANCH, sortOrder: 88 });
    store.links.push({
      id: "link-3",
      organizationId: ORG_A,
      sourceId: ORG_A_ROOTS[0] as string,
      targetId: nested,
      linkType: LinkType.Produces,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const result = await bulkRank({
      orderedArtifactIds: [
        ORG_A_ROOTS[2],
        ORG_A_ROOTS[1],
        ORG_A_ROOTS[0],
      ] as string[],
      expectedRankEpoch: await currentEpoch(),
    });

    expect(result.ok).toBe(true);
    expect(sortOrdersOf([nested, branch])).toEqual([77, 88]);
  });

  it("accepts an empty order for a project with no roots", async () => {
    store.artifacts = store.artifacts.filter(
      (row) => row.organizationId !== ORG_A
    );

    const result = await bulkRank({
      orderedArtifactIds: [],
      expectedRankEpoch: await currentEpoch(),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.orderedArtifactIds).toEqual([]);
  });

  it("takes the project rank lock before it reads the population", async () => {
    // Ordering is the whole contract: a lock taken AFTER the read would let a
    // rival with a different idempotency key read the same epoch, pass
    // validation, and overwrite this rewrite with no conflict reported. The
    // rival race itself needs a real Postgres and lives in
    // `__tests__/integration/artifact-bulk-rank-service.test.ts`; what is
    // checkable here is that the lock is the transaction's first statement.
    await bulkRank({
      orderedArtifactIds: [...ORG_A_ROOTS].reverse(),
      expectedRankEpoch: await currentEpoch(),
    });

    const writeStatements = statementLog.slice(
      statementLog.indexOf("$executeRaw")
    );
    expect(writeStatements.slice(0, 3)).toEqual([
      "$executeRaw",
      "artifact.findMany",
      "artifactLink.findMany",
    ]);
    expect(rawQueries).toHaveLength(1);
    expect(rawQueries[0]).toContain("pg_advisory_xact_lock");
  });

  it("scopes the PRODUCES read by project rather than by an id list", async () => {
    // ISS-8999 review: an `id IN (…)` pair carried every artifact in the
    // project TWICE as bind parameters and could exceed Postgres' parameter
    // limit before anything was ranked. Org B's own edge must stay invisible
    // even though the filter is now a join predicate rather than an id set.
    const orgBNested = artifactId("b", 3);
    seedArtifact({
      id: orgBNested,
      organizationId: ORG_B,
      projectId: PROJECT_B,
      sortOrder: 3 * STACK_RANK_GAP,
    });
    store.links.push({
      id: "link-cross",
      organizationId: ORG_B,
      sourceId: ORG_B_ROOTS[0] as string,
      targetId: orgBNested,
      linkType: LinkType.Produces,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const state = await artifactBulkRankService.getRankState(PROJECT_A, ORG_A);

    expect(state.orderedRootIds).toEqual(ORG_A_ROOTS);
    expect(
      (await artifactBulkRankService.getRankState(PROJECT_B, ORG_B))
        .orderedRootIds
    ).toEqual(ORG_B_ROOTS);
  });
});
