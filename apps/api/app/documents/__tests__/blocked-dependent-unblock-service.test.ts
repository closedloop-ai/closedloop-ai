import { IssueStatus } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9632 — the two branches the DB-backed suite cannot stage, both of which
 * are load-bearing contracts rather than edge cases:
 *
 *  - FAILURE ISOLATION: the status write the caller asked for has already
 *    committed when this runs, and both routes `await` it in the request path.
 *    A throw here would turn a successful write into a 500.
 *  - THE CONCURRENT-WRITE GUARD: the `updateManyAndReturn` re-asserts both
 *    `status = BLOCKED` and the blocker predicate, and can therefore write FEWER
 *    rows than the resolver resolved. The audit row must be recorded from what
 *    was written, never from what was resolved — an activity event for a
 *    transition the update declined is a lie about the artifact. Every DB-backed
 *    case in `../blocked-dependent-unblock.integration.test.ts` is
 *    single-threaded, so only an injected shortfall can decide this. That the
 *    predicate itself declines the right rows IS DB-backed, in
 *    `../blocked-dependent-unblock-write-guard.integration.test.ts` — a
 *    hand-written double would report any `where` green.
 */

const captureAutomatedUnblock = vi.hoisted(() => vi.fn());
const withDbMock = vi.hoisted(() => vi.fn());
const withDbTx = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: Object.assign(withDbMock, { tx: withDbTx }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureAutomatedUnblock: (...args: unknown[]) =>
    captureAutomatedUnblock(...args),
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  blockedDependentUnblockService,
  UNBLOCK_CANDIDATE_CHUNK_SIZE,
} from "../blocked-dependent-unblock-service";

const ORG = "org-1";
const BLOCKER = "blocker-1";
const DEPENDENT = "dependent-1";
const OTHER_DEPENDENT = "dependent-2";

/**
 * A `tx` double for a run that resolves `resolved` dependents and whose guarded
 * `updateMany` lands only `written` of them.
 *
 * The call order it encodes is the production order: changed artifacts →
 * outbound BLOCKS edges → BLOCKED candidates → inbound BLOCKS edges → the
 * blocker SOURCES resolved by their own org-scoped read → the guarded
 * `updateManyAndReturn`, which reports the rows it actually wrote.
 */
function txDouble(resolved: string[], written: string[]) {
  return {
    artifact: {
      findMany: vi
        .fn()
        // 1: the changed artifacts, read back post-commit.
        .mockResolvedValueOnce([
          { id: BLOCKER, subtype: "FEATURE", status: IssueStatus.Done },
        ])
        // 2: the BLOCKED candidates.
        .mockResolvedValueOnce(
          resolved.map((id) => ({ id, subtype: "FEATURE" }))
        )
        // 3: the blocker sources, org-scoped — all terminal here.
        .mockResolvedValue([
          { id: BLOCKER, subtype: "FEATURE", status: IssueStatus.Done },
        ]),
      updateManyAndReturn: vi
        .fn()
        .mockResolvedValue(written.map((id) => ({ id }))),
    },
    artifactLink: {
      findMany: vi
        .fn()
        // outbound edges from the terminal blocker
        .mockResolvedValueOnce(resolved.map((id) => ({ targetId: id })))
        // inbound edges for each candidate, all from the terminal blocker
        .mockResolvedValue(
          resolved.map((id) => ({ targetId: id, sourceId: BLOCKER }))
        ),
    },
  };
}

function wireDb(tx: ReturnType<typeof txDouble>) {
  withDbMock.mockImplementation((fn: (db: unknown) => unknown) => fn(tx));
  withDbTx.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
}

/**
 * The first atomic write succeeds and the second rejects, reproducing a
 * partial run without claiming the failed statement landed.
 */
function wireChunkFailure(
  tx: ReturnType<typeof txDouble>,
  firstWrittenId: string
) {
  wireDb(tx);
  tx.artifact.updateManyAndReturn
    .mockResolvedValueOnce([{ id: firstWrittenId }])
    .mockRejectedValueOnce(new Error("chunk 2 died"));
}

describe("resolveBlocksForChangedArtifacts partial commits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports and audits the chunks that committed before a later chunk failed", async () => {
    // One candidate per chunk. Chunk 1 commits; chunk 2 throws. Before the
    // audit moved inside the loop, this returned a clean empty outcome and
    // recorded NO event for the row sitting in TODO — a status change with no
    // actor and no audit row, indistinguishable from a bug.
    const chunkIds = Array.from(
      { length: UNBLOCK_CANDIDATE_CHUNK_SIZE + 1 },
      (_, index) => `dependent-${index}`
    );
    const tx = txDouble([chunkIds[0] as string], [chunkIds[0] as string]);
    const terminalBlocker = {
      id: BLOCKER,
      subtype: "FEATURE",
      status: IssueStatus.Done,
    };
    tx.artifact.findMany.mockReset();
    tx.artifact.findMany
      .mockResolvedValueOnce([terminalBlocker])
      .mockResolvedValueOnce([
        { id: chunkIds[0] as string, subtype: "FEATURE" },
      ])
      .mockResolvedValueOnce([terminalBlocker])
      .mockResolvedValueOnce([
        { id: chunkIds.at(-1) as string, subtype: "FEATURE" },
      ])
      .mockResolvedValueOnce([terminalBlocker]);
    tx.artifactLink.findMany.mockReset();
    tx.artifactLink.findMany
      .mockResolvedValueOnce(chunkIds.map((id) => ({ targetId: id })))
      .mockResolvedValueOnce([
        { targetId: chunkIds[0] as string, sourceId: BLOCKER },
      ])
      .mockResolvedValueOnce([
        { targetId: chunkIds.at(-1) as string, sourceId: BLOCKER },
      ]);
    wireChunkFailure(tx, chunkIds[0] as string);

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(tx.artifact.updateManyAndReturn).toHaveBeenCalledTimes(2);
    // ISS-10993: one transaction per chunk, so each chunk's receipt commits
    // with the transitions it describes rather than with a later chunk's.
    expect(withDbTx).toHaveBeenCalledTimes(2);
    // ISS-10993: EVERY chunk carries the explicit budget. The literal is
    // deliberate — importing the constant would assert the call against
    // whatever it currently holds, so both a deleted option and a silently
    // changed value would stay green, which is the hole this closes.
    expect(withDbTx).toHaveBeenNthCalledWith(1, expect.any(Function), {
      timeout: 30_000,
    });
    expect(withDbTx).toHaveBeenNthCalledWith(2, expect.any(Function), {
      timeout: 30_000,
    });
    expect(tx.artifact.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORG,
        id: { in: chunkIds.slice(0, UNBLOCK_CANDIDATE_CHUNK_SIZE) },
        status: IssueStatus.Blocked,
      },
      select: { id: true, subtype: true },
    });
    expect(tx.artifact.findMany).toHaveBeenNthCalledWith(4, {
      where: {
        organizationId: ORG,
        id: { in: [chunkIds.at(-1)] },
        status: IssueStatus.Blocked,
      },
      select: { id: true, subtype: true },
    });
    // The committed chunk is reported, not swallowed into an empty outcome…
    expect(outcome.unblockedIds).toEqual([chunkIds[0]]);
    // …and it carries its audit row.
    expect(captureAutomatedUnblock).toHaveBeenCalledTimes(1);
    // ISS-10993: the receipt is written on the CHUNK'S transaction, so it
    // commits or rolls back with the transitions it describes.
    expect(captureAutomatedUnblock).toHaveBeenCalledWith({
      tx,
      organizationId: ORG,
      changes: [
        {
          artifactId: chunkIds[0],
          before: IssueStatus.Blocked,
          after: IssueStatus.Todo,
        },
      ],
    });
  });
});

describe("resolveBlocksForChangedArtifacts failure isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("swallows a database failure instead of failing the write that already committed", async () => {
    withDbMock.mockRejectedValue(new Error("connection reset"));
    withDbTx.mockRejectedValue(new Error("connection reset"));

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome).toEqual({ resolvedIds: [], unblockedIds: [] });
    expect(captureAutomatedUnblock).not.toHaveBeenCalled();
  });

  it("does not report or audit a guarded write when its response fails", async () => {
    const tx = txDouble([DEPENDENT], [DEPENDENT]);
    wireDb(tx);
    let call = 0;
    withDbMock.mockImplementation(async (fn: (db: unknown) => unknown) => {
      call += 1;
      const result = await fn(tx);
      if (call === 3) {
        throw new Error("write response failed");
      }
      return result;
    });

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome).toEqual({ resolvedIds: [], unblockedIds: [] });
    expect(captureAutomatedUnblock).not.toHaveBeenCalled();
  });
});

describe("resolveBlocksForChangedArtifacts concurrent-write guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the audit row for what was WRITTEN, not for what was resolved", async () => {
    // The resolver resolves one dependent; the guarded update writes none,
    // because a concurrent write moved it out of BLOCKED first.
    wireDb(txDouble([DEPENDENT], []));

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome.resolvedIds).toEqual([DEPENDENT]);
    expect(outcome.unblockedIds).toEqual([]);
    // The whole point: no activity event for a transition that did not happen.
    expect(captureAutomatedUnblock).not.toHaveBeenCalled();
  });

  it("records only the WRITTEN subset when the update lands part of the batch", async () => {
    // Two resolved, one written. This is the only shape in which the two sets
    // are BOTH non-empty AND different, so it is the only one where reading the
    // audit payload off `resolvedIds` instead of `unblockedIds` is observable.
    const tx = txDouble([DEPENDENT, OTHER_DEPENDENT], [OTHER_DEPENDENT]);
    wireDb(tx);

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome.resolvedIds).toEqual([DEPENDENT, OTHER_DEPENDENT]);
    expect(outcome.unblockedIds).toEqual([OTHER_DEPENDENT]);
    expect(captureAutomatedUnblock).toHaveBeenCalledTimes(1);
    expect(captureAutomatedUnblock).toHaveBeenCalledWith({
      tx,
      organizationId: ORG,
      changes: [
        {
          artifactId: OTHER_DEPENDENT,
          before: IssueStatus.Blocked,
          after: IssueStatus.Todo,
        },
      ],
    });
  });

  it("records the audit row when the update did land", async () => {
    const tx = txDouble([DEPENDENT], [DEPENDENT]);
    wireDb(tx);

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome.unblockedIds).toEqual([DEPENDENT]);
    expect(captureAutomatedUnblock).toHaveBeenCalledWith({
      tx,
      organizationId: ORG,
      changes: [
        {
          artifactId: DEPENDENT,
          before: IssueStatus.Blocked,
          after: IssueStatus.Todo,
        },
      ],
    });
  });
});
