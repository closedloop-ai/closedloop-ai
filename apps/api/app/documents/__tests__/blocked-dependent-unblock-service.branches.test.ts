import { ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Branch gaps the sibling `blocked-dependent-unblock-service.test.ts` suite
 * does not reach: the forward path's own short-circuits before it ever opens
 * a chunk transaction (no changed ids, no terminal transitions), the shared
 * resolver's early returns (no BLOCKED candidates, no inbound edges, an edge
 * whose source cannot be resolved in this organization), and the reconcile
 * sweep's keyset pagination, which no test in the whole suite (including the
 * DB-backed integration files) currently drives at all.
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

import { blockedDependentUnblockService } from "../blocked-dependent-unblock-service";

const ORG = "org-1";
const BLOCKER = "blocker-1";
const DEPENDENT = "dependent-1";

function wireDb(tx: unknown) {
  withDbMock.mockImplementation((fn: (db: unknown) => unknown) => fn(tx));
  withDbTx.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
}

describe("resolveBlocksForChangedArtifacts — short-circuits before opening a transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty outcome without touching the database when nothing changed", async () => {
    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [],
      });

    expect(outcome).toEqual({ resolvedIds: [], unblockedIds: [] });
    expect(withDbMock).not.toHaveBeenCalled();
    expect(withDbTx).not.toHaveBeenCalled();
    expect(captureAutomatedUnblock).not.toHaveBeenCalled();
  });

  it("never reads blocker edges when none of the changed artifacts reached a terminal status", async () => {
    const artifactFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        { id: BLOCKER, subtype: "FEATURE", status: IssueStatus.InProgress },
      ]);
    const artifactLinkFindMany = vi.fn();
    wireDb({
      artifact: { findMany: artifactFindMany },
      artifactLink: { findMany: artifactLinkFindMany },
    });

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome).toEqual({ resolvedIds: [], unblockedIds: [] });
    expect(artifactLinkFindMany).not.toHaveBeenCalled();
    expect(withDbTx).not.toHaveBeenCalled();
    expect(captureAutomatedUnblock).not.toHaveBeenCalled();
  });
});

describe("resolveBlocksForChangedArtifacts — resolver early returns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves nothing when the outbound-edge targets are not currently BLOCKED", async () => {
    const artifactFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        { id: BLOCKER, subtype: "FEATURE", status: IssueStatus.Done },
      ])
      // The BLOCKED-candidates query for the chunk comes back empty: the
      // dependent moved out of BLOCKED (or was never in it) before this ran.
      .mockResolvedValueOnce([]);
    const artifactLinkFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ targetId: DEPENDENT }]);
    const updateManyAndReturn = vi.fn();
    wireDb({
      artifact: { findMany: artifactFindMany, updateManyAndReturn },
      artifactLink: { findMany: artifactLinkFindMany },
    });

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome).toEqual({ resolvedIds: [], unblockedIds: [] });
    // Only ONE artifactLink read happened — the outbound-edges query. The
    // resolver returned before ever reading inbound edges for this chunk.
    expect(artifactLinkFindMany).toHaveBeenCalledTimes(1);
    expect(updateManyAndReturn).not.toHaveBeenCalled();
    expect(captureAutomatedUnblock).not.toHaveBeenCalled();
  });

  it("resolves nothing for a BLOCKED candidate with no inbound BLOCKS edge", async () => {
    const artifactFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        { id: BLOCKER, subtype: "FEATURE", status: IssueStatus.Done },
      ])
      .mockResolvedValueOnce([{ id: DEPENDENT, subtype: "FEATURE" }]);
    const artifactLinkFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ targetId: DEPENDENT }])
      // No inbound BLOCKS edges land on this candidate at all — an
      // unmodelled manual block, not this sweep's population.
      .mockResolvedValueOnce([]);
    const updateManyAndReturn = vi.fn();
    wireDb({
      artifact: { findMany: artifactFindMany, updateManyAndReturn },
      artifactLink: { findMany: artifactLinkFindMany },
    });

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    expect(outcome).toEqual({ resolvedIds: [], unblockedIds: [] });
    // The resolver returned before reading blocker SOURCES: a third
    // `artifact.findMany` call would be that read.
    expect(artifactFindMany).toHaveBeenCalledTimes(2);
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("treats an edge whose source cannot be resolved in this organization as still blocking", async () => {
    const artifactFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        { id: BLOCKER, subtype: "FEATURE", status: IssueStatus.Done },
      ])
      .mockResolvedValueOnce([{ id: DEPENDENT, subtype: "FEATURE" }])
      // The blocker source read comes back empty: `sourceById` has no entry
      // for "ghost-blocker", so `?? null` decides the pairing.
      .mockResolvedValueOnce([]);
    const artifactLinkFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ targetId: DEPENDENT }])
      .mockResolvedValueOnce([
        { targetId: DEPENDENT, sourceId: "ghost-blocker" },
      ]);
    const updateManyAndReturn = vi.fn();
    wireDb({
      artifact: { findMany: artifactFindMany, updateManyAndReturn },
      artifactLink: { findMany: artifactLinkFindMany },
    });

    const outcome =
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId: ORG,
        changedArtifactIds: [BLOCKER],
      });

    // A source the org-scoped read cannot see counts as still blocking, so
    // the candidate is resolved as NOT unblockable — outcome stays empty.
    expect(outcome).toEqual({ resolvedIds: [], unblockedIds: [] });
    expect(artifactFindMany).toHaveBeenNthCalledWith(3, {
      where: { organizationId: ORG, id: { in: ["ghost-blocker"] } },
      select: { id: true, subtype: true, status: true },
    });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });
});

describe("reconcile sweep — keyset pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scans nothing when the org has no BLOCKED page at all", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]);
    wireDb({ artifact: { findMany } });

    const outcome =
      await blockedDependentUnblockService.previewStaleBlockedArtifacts({
        organizationId: ORG,
        pageSize: 2,
      });

    expect(outcome).toEqual({
      organizationId: ORG,
      scanned: 0,
      resolvedIds: [],
      unblockedIds: [],
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        type: ArtifactType.Document,
        status: IssueStatus.Blocked,
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 2,
    });
  });

  it("defaults the page size when the caller supplies none", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]);
    wireDb({ artifact: { findMany } });

    await blockedDependentUnblockService.previewStaleBlockedArtifacts({
      organizationId: ORG,
    });

    // RECONCILE_BLOCKED_PAGE_SIZE is a file-local constant, not exported —
    // pinned as a literal on purpose so a change to the default is visible.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 })
    );
  });

  it("clamps a non-positive caller-supplied page size up to 1", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]);
    wireDb({ artifact: { findMany } });

    await blockedDependentUnblockService.previewStaleBlockedArtifacts({
      organizationId: ORG,
      pageSize: 0,
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });

  it("carries the cursor forward across a full page and stops on a partial one", async () => {
    const findMany = vi
      .fn()
      // Page 1 (full, pageSize=2) …
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      // … followed by the resolver's own BLOCKED-candidates check for that
      // page, which this test declines so no further reads happen per page.
      .mockResolvedValueOnce([])
      // Page 2 (partial, length 1 < pageSize) …
      .mockResolvedValueOnce([{ id: "c" }])
      .mockResolvedValueOnce([]);
    wireDb({ artifact: { findMany } });

    const outcome =
      await blockedDependentUnblockService.previewStaleBlockedArtifacts({
        organizationId: ORG,
        pageSize: 2,
      });

    expect(outcome.scanned).toBe(3);
    // Two sweep pages, each followed by the resolver's own candidates check.
    expect(findMany).toHaveBeenCalledTimes(4);
    // First page has no cursor predicate at all.
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("id");
    // Second page's cursor is the first page's LAST row.
    expect(findMany.mock.calls[2][0].where).toMatchObject({
      id: { gt: "b" },
    });
  });
});
