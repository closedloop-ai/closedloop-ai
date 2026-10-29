import {
  BranchTraceCompletenessState,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { BranchTracePageMode } from "@repo/api/src/types/branch-trace-paging";
import {
  collectSessionTraceItems,
  mergeCollectedTraceSessions,
} from "@repo/lib/branches/merged-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/lib/branches/merged-trace", { spy: true });

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

const sessionDetailReadMocks = vi.hoisted(() => ({
  readAgentSessionDetailInputs: vi.fn(),
  projectAgentSessionDetail: vi.fn(),
}));

vi.mock("@/app/agent-sessions/service/session-detail-read", () => ({
  readAgentSessionDetailInputs:
    sessionDetailReadMocks.readAgentSessionDetailInputs,
  projectAgentSessionDetail: sessionDetailReadMocks.projectAgentSessionDetail,
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall } from "../../__tests__/utils/db-helpers";
import { branchTraceQuerySchema } from "./branch-list-query";
import { clearBranchTraceCacheForTests } from "./branch-read-service/branch-trace-cache";
import { readCloudBranchTrace } from "./branch-read-service/branch-trace-read";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("branchTraceQuerySchema", () => {
  it("accepts paged and complete trace query shapes", () => {
    expect(branchTraceQuerySchema.parse({})).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(branchTraceQuerySchema.parse({ limit: 100 })).toEqual({
      limit: 100,
      offset: 0,
    });
    expect(branchTraceQuerySchema.parse({ complete: "true" })).toEqual({
      complete: true,
    });
    expect(branchTraceQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false
    );
    expect(
      branchTraceQuerySchema.safeParse({ complete: "true", limit: 50 }).success
    ).toBe(false);
    expect(
      branchTraceQuerySchema.safeParse({ complete: "false" }).success
    ).toBe(false);
  });
});

describe("readCloudBranchTrace", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearBranchTraceCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ firstPushedAt: now })
    );
  });

  it("returns the complete ordered trace in one response when requested", async () => {
    mockLinkedSessions(["sess-a", "sess-b", "sess-c"]);

    const response = await readCloudBranchTrace(organizationId, branchId, {
      complete: true,
    });

    expect(response?.items.map(traceItemSession)).toEqual([
      "sess-a",
      "sess-b",
      "sess-c",
    ]);
    expect(response?.hasMore).toBe(false);
    expect(response?.traceState?.qualifyingSessionCount).toBe(3);
    expect(response?.traceState?.completeness.state).toBe(
      BranchTraceCompletenessState.Complete
    );
    // ISS-9112: three linked sessions, ONE hydration read. The literal is the
    // whole point — it was 3 before, one per session.
    expect(
      sessionDetailReadMocks.readAgentSessionDetailInputs
    ).toHaveBeenCalledTimes(1);
  });

  it("hydrates and merges once across successive pages", async () => {
    mockLinkedSessions(["sess-a", "sess-b", "sess-c"]);
    const pages: Awaited<ReturnType<typeof readCloudBranchTrace>>[] = [];
    for (let offset = 0; offset < 3; offset += 1) {
      pages.push(
        await readCloudBranchTrace(organizationId, branchId, {
          limit: 1,
          offset,
        })
      );
    }
    expect(
      pages.flatMap((page) => page?.items ?? []).map(traceItemSession)
    ).toEqual(["sess-a", "sess-b", "sess-c"]);
    expect(
      sessionDetailReadMocks.readAgentSessionDetailInputs
    ).toHaveBeenCalledTimes(1);
    expect(mergeCollectedTraceSessions).toHaveBeenCalledTimes(1);
    expect(collectSessionTraceItems).toHaveBeenCalledTimes(3);
  });

  it("rebuilds after a member session update", async () => {
    mockLinkedSessions(["sess-a"]);
    await readCloudBranchTrace(organizationId, branchId, { complete: true });
    const links = await mockDb.artifactLink.findMany();
    links[0].source.session.updatedAt = new Date(now.getTime() + 1);
    await readCloudBranchTrace(organizationId, branchId, { complete: true });
    expect(
      sessionDetailReadMocks.readAgentSessionDetailInputs
    ).toHaveBeenCalledTimes(2);
  });

  it("uses an opaque cursor and resets instead of mixing updated snapshots", async () => {
    mockLinkedSessions(["sess-a", "sess-b", "sess-c"]);
    const first = await readCloudBranchTrace(organizationId, branchId, {
      pageMode: BranchTracePageMode.Cursor,
      limit: 1,
    });
    expect(first?.overviewItems).toHaveLength(3);
    expect(first?.nextCursor).toBeDefined();
    const second = await readCloudBranchTrace(organizationId, branchId, {
      pageMode: BranchTracePageMode.Cursor,
      limit: 1,
      cursor: first?.nextCursor,
    });
    expect(second?.items.map(traceItemSession)).toEqual(["sess-b"]);
    expect(second?.overviewItems).toBeUndefined();
    expect(
      sessionDetailReadMocks.readAgentSessionDetailInputs
    ).toHaveBeenCalledTimes(1);
    mockLinkedSessions(["sess-a", "sess-d"]);
    const updated = await readCloudBranchTrace(organizationId, branchId, {
      pageMode: BranchTracePageMode.Cursor,
      limit: 1,
      cursor: second?.nextCursor,
    });
    expect(updated?.reset).toBe(true);
    expect(updated?.items.map(traceItemSession)).toEqual(["sess-a"]);
    expect(updated?.overviewItems?.map(traceItemSession)).toEqual([
      "sess-a",
      "sess-d",
    ]);
    expect(
      sessionDetailReadMocks.readAgentSessionDetailInputs
    ).toHaveBeenCalledTimes(2);
  });

  it("does not return a cached trace once the authorized branch disappears", async () => {
    mockLinkedSessions(["sess-a"]);
    await readCloudBranchTrace(organizationId, branchId, { complete: true });
    mockDb.artifact.findFirst.mockResolvedValue(null);
    expect(
      await readCloudBranchTrace(organizationId, branchId, { complete: true })
    ).toBeNull();
  });

  function mockLinkedSessions(ids: string[]) {
    mockDb.artifactLink.findMany.mockResolvedValue(
      ids.map((id, index) => ({
        id: `link-${id}`,
        sourceId: id,
        createdAt: new Date(now.getTime() - index),
        source: {
          id,
          updatedAt: now,
          name: `session ${id}`,
          slug: `SES-${index}`,
          session: { artifactId: id, externalSessionId: id, updatedAt: now },
        },
      }))
    );
    const byId = new Map(
      ids.map((id, index) => [
        id,
        {
          id,
          name: `session ${id}`,
          primaryModel: null,
          model: null,
          harness: "claude",
          startedAt: new Date(now.getTime() + index * 60_000),
          turnItems: [],
        },
      ])
    );
    sessionDetailReadMocks.readAgentSessionDetailInputs.mockImplementation(
      async ({ ids: requested }: { ids: string[] }) =>
        requested.flatMap((id) =>
          byId.has(id) ? [{ record: { artifactId: id } }] : []
        )
    );
    sessionDetailReadMocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) =>
        byId.get(record.artifactId)
    );
  }
});

function traceItemSession(item: MergedTraceItem) {
  return item.sessionId;
}
