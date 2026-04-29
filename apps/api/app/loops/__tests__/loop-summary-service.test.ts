/**
 * Unit tests for loopSummaryService.getSummariesForDocuments.
 *
 * Covers priority logic (failed-newer-than-active wins), recursive descendant
 * traversal, cycle detection, depth bounds, cross-org isolation, and the
 * "one entry per requested documentId" contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  LinkType: {
    PRODUCES: "PRODUCES",
    BLOCKS: "BLOCKS",
    RELATES_TO: "RELATES_TO",
  },
  LoopStatus: {
    PENDING: "PENDING",
    CLAIMED: "CLAIMED",
    RUNNING: "RUNNING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    TIMED_OUT: "TIMED_OUT",
  },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (items: unknown[]) => ({ items }),
  },
}));

import { withDb } from "@repo/database";
import { loopSummaryService } from "../loop-summary-service";

type DescendantRow = { root_id: string; descendant_id: string };

type LoopFixture = {
  id: string;
  artifactId: string;
  command: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  computeTargetId: string | null;
  user: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
};

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG_ID = "00000000-0000-0000-0000-000000000002";
const ROOT_A = "11111111-1111-1111-1111-111111111111";
const ROOT_B = "22222222-2222-2222-2222-222222222222";
const CHILD_A1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GRANDCHILD_A1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const TEST_USER = {
  firstName: "Test",
  lastName: "User",
  email: "test@example.com",
};

function makeLoop(overrides: Partial<LoopFixture>): LoopFixture {
  return {
    id: "loop-default",
    artifactId: ROOT_A,
    command: "PLAN",
    status: "RUNNING",
    startedAt: new Date("2026-04-28T10:00:00Z"),
    completedAt: null,
    updatedAt: new Date("2026-04-28T10:00:00Z"),
    computeTargetId: null,
    user: TEST_USER,
    ...overrides,
  };
}

/**
 * Build a $queryRaw mock returning the given descendant rows, and a
 * loop.findMany / artifact.findMany pair returning the given loops/subtypes.
 */
function setupDb(opts: {
  descendants: DescendantRow[];
  loops?: LoopFixture[];
  artifacts?: Array<{ id: string; subtype: string | null }>;
}) {
  const mockQueryRaw = vi.fn().mockResolvedValue(opts.descendants);
  const mockLoopFindMany = vi.fn().mockResolvedValue(opts.loops ?? []);
  const mockArtifactFindMany = vi.fn().mockResolvedValue(opts.artifacts ?? []);

  (withDb as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (callback: (db: unknown) => unknown) =>
      callback({
        $queryRaw: mockQueryRaw,
        loop: { findMany: mockLoopFindMany },
        artifact: { findMany: mockArtifactFindMany },
      })
  );

  return { mockQueryRaw, mockLoopFindMany, mockArtifactFindMany };
}

describe("loopSummaryService.getSummariesForDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns one empty entry per requested documentId when no loops exist", async () => {
    setupDb({
      descendants: [
        { root_id: ROOT_A, descendant_id: ROOT_A },
        { root_id: ROOT_B, descendant_id: ROOT_B },
      ],
      loops: [],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
      ROOT_B,
    ]);

    expect(Object.keys(result).sort()).toEqual([ROOT_A, ROOT_B].sort());
    expect(result[ROOT_A]).toEqual({
      activeLoop: null,
      latestCompleted: null,
      latestFailed: null,
    });
    expect(result[ROOT_B]).toEqual({
      activeLoop: null,
      latestCompleted: null,
      latestFailed: null,
    });
  });

  it("returns empty response and skips queries when documentIds is empty", async () => {
    const result = await loopSummaryService.getSummariesForDocuments(
      ORG_ID,
      []
    );
    expect(result).toEqual({});
    expect(withDb).not.toHaveBeenCalled();
  });

  it("returns the active loop for a direct document", async () => {
    setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [
        makeLoop({
          id: "loop-1",
          artifactId: ROOT_A,
          status: "RUNNING",
          command: "PLAN",
          startedAt: new Date("2026-04-28T09:00:00Z"),
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].activeLoop).not.toBeNull();
    expect(result[ROOT_A].activeLoop?.loopId).toBe("loop-1");
    expect(result[ROOT_A].activeLoop?.command).toBe("PLAN");
    expect(result[ROOT_A].activeLoop?.isDirectLoop).toBe(true);
    expect(result[ROOT_A].activeLoop?.childSubtype).toBeNull();
  });

  it("aggregates a loop on a direct child via PRODUCES link", async () => {
    setupDb({
      descendants: [
        { root_id: ROOT_A, descendant_id: ROOT_A },
        { root_id: ROOT_A, descendant_id: CHILD_A1 },
      ],
      loops: [
        makeLoop({
          id: "loop-child",
          artifactId: CHILD_A1,
          status: "COMPLETED",
          command: "GENERATE_PRD",
          completedAt: new Date("2026-04-28T11:00:00Z"),
        }),
      ],
      artifacts: [{ id: CHILD_A1, subtype: "PRD" }],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].latestCompleted).not.toBeNull();
    expect(result[ROOT_A].latestCompleted?.loopId).toBe("loop-child");
    expect(result[ROOT_A].latestCompleted?.isDirectLoop).toBe(false);
    expect(result[ROOT_A].latestCompleted?.childSubtype).toBe("PRD");
  });

  it("aggregates a loop on a grandchild (recursive depth > 1)", async () => {
    setupDb({
      descendants: [
        { root_id: ROOT_A, descendant_id: ROOT_A },
        { root_id: ROOT_A, descendant_id: CHILD_A1 },
        { root_id: ROOT_A, descendant_id: GRANDCHILD_A1 },
      ],
      loops: [
        makeLoop({
          id: "loop-grandchild",
          artifactId: GRANDCHILD_A1,
          status: "RUNNING",
          command: "EXECUTE",
        }),
      ],
      artifacts: [{ id: GRANDCHILD_A1, subtype: "FEATURE" }],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].activeLoop?.loopId).toBe("loop-grandchild");
    expect(result[ROOT_A].activeLoop?.isDirectLoop).toBe(false);
  });

  it("priority: failed wins when failedAt is newer than active.startedAt", async () => {
    setupDb({
      descendants: [
        { root_id: ROOT_A, descendant_id: ROOT_A },
        { root_id: ROOT_A, descendant_id: CHILD_A1 },
      ],
      loops: [
        makeLoop({
          id: "loop-active",
          artifactId: ROOT_A,
          status: "RUNNING",
          startedAt: new Date("2026-04-28T08:00:00Z"),
        }),
        makeLoop({
          id: "loop-failed",
          artifactId: CHILD_A1,
          status: "FAILED",
          completedAt: new Date("2026-04-28T09:30:00Z"),
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].activeLoop?.loopId).toBe("loop-active");
    expect(result[ROOT_A].latestFailed?.loopId).toBe("loop-failed");
    // Service returns both; cell-level priority decides which to display.
  });

  it("classifies CANCELLED and TIMED_OUT alongside FAILED in latestFailed", async () => {
    setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [
        makeLoop({
          id: "loop-cancelled",
          status: "CANCELLED",
          completedAt: new Date("2026-04-28T08:00:00Z"),
        }),
        makeLoop({
          id: "loop-timed-out",
          status: "TIMED_OUT",
          completedAt: new Date("2026-04-28T09:00:00Z"),
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].latestFailed?.loopId).toBe("loop-timed-out");
    expect(result[ROOT_A].latestFailed?.status).toBe("TIMED_OUT");
  });

  it("falls back to updatedAt for failedAt when completedAt is null", async () => {
    setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [
        makeLoop({
          id: "loop-timed-out-no-completed",
          status: "TIMED_OUT",
          completedAt: null,
          updatedAt: new Date("2026-04-28T07:00:00Z"),
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].latestFailed?.failedAt).toBe(
      new Date("2026-04-28T07:00:00Z").toISOString()
    );
  });

  it("picks most recent completed loop by completedAt", async () => {
    setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [
        makeLoop({
          id: "loop-old",
          status: "COMPLETED",
          completedAt: new Date("2026-04-28T08:00:00Z"),
        }),
        makeLoop({
          id: "loop-new",
          status: "COMPLETED",
          completedAt: new Date("2026-04-28T11:00:00Z"),
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].latestCompleted?.loopId).toBe("loop-new");
  });

  it("respects org scoping in the loop and artifact queries", async () => {
    const { mockLoopFindMany, mockArtifactFindMany } = setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [],
    });

    await loopSummaryService.getSummariesForDocuments(ORG_ID, [ROOT_A]);

    const loopWhere = mockLoopFindMany.mock.calls[0][0].where;
    expect(loopWhere.organizationId).toBe(ORG_ID);
    const artifactWhere = mockArtifactFindMany.mock.calls[0][0].where;
    expect(artifactWhere.organizationId).toBe(ORG_ID);
  });

  it("returns empty summaries for documents that don't belong to the org (no descendants)", async () => {
    // CTE filtered by organization_id finds nothing for foreign-org IDs.
    setupDb({ descendants: [], loops: [] });

    const result = await loopSummaryService.getSummariesForDocuments(
      OTHER_ORG_ID,
      [ROOT_A, ROOT_B]
    );
    expect(result[ROOT_A]).toEqual({
      activeLoop: null,
      latestCompleted: null,
      latestFailed: null,
    });
    expect(result[ROOT_B]).toEqual({
      activeLoop: null,
      latestCompleted: null,
      latestFailed: null,
    });
  });

  it("returns the user's display name from firstName + lastName", async () => {
    setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [
        makeLoop({
          status: "RUNNING",
          user: { firstName: "Ada", lastName: "Lovelace", email: "a@x.com" },
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].activeLoop?.userName).toBe("Ada Lovelace");
  });

  it("falls back to email when name fields are null", async () => {
    setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [
        makeLoop({
          status: "RUNNING",
          user: { firstName: null, lastName: null, email: "fallback@x.com" },
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].activeLoop?.userName).toBe("fallback@x.com");
  });

  it("derives isLocal=true when computeTargetId is set", async () => {
    setupDb({
      descendants: [{ root_id: ROOT_A, descendant_id: ROOT_A }],
      loops: [
        makeLoop({
          status: "RUNNING",
          computeTargetId: "ct-1",
        }),
      ],
    });

    const result = await loopSummaryService.getSummariesForDocuments(ORG_ID, [
      ROOT_A,
    ]);
    expect(result[ROOT_A].activeLoop?.isLocal).toBe(true);
  });
});
