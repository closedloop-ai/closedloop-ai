import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  BranchParticipationKind,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

/**
 * The Branch merged-trace read, split out of `branch-read-service.test.ts`
 * (ISS-9112) — the population it hydrates and the way it hydrates it are their
 * own responsibility, and the file it came from is over the size ceiling.
 */
describe("branchReadService merged trace", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  // The frozen clock is worker-wide state, so a throwing assertion would leak it
  // into every later file this worker runs and report them as unrelated red.
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getBranchTrace", () => {
    function mockLinkedSessions(ids: string[]) {
      mockDb.artifact.findFirst.mockResolvedValue(
        makeBranchRow({ firstPushedAt: now })
      );
      mockDb.artifactLink.findMany.mockResolvedValue(
        ids.map((id, index) => ({
          id: `link-${id}`,
          sourceId: id,
          createdAt: new Date(now.getTime() - index),
          source: {
            id,
            name: `session ${id}`,
            slug: `SES-${index}`,
            session: { artifactId: id, externalSessionId: id },
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

    it("interleaves one sessionstart per linked session, chronologically", async () => {
      mockLinkedSessions(["sess-a", "sess-b", "sess-c"]);

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 50, offset: 0 }
      );

      expect(response?.viewerScope).toBe(BranchViewerScope.Organization);
      expect(
        response?.items.map((item) => [item.type, item.sessionId])
      ).toEqual([
        ["sessionstart", "sess-a"],
        ["sessionstart", "sess-b"],
        ["sessionstart", "sess-c"],
      ]);
      expect(response?.hasMore).toBe(false);
      // FEA-3568 / ISS-7229: the merged trace renders neither the tiling nor a
      // per-session cost, so it opts out of BOTH lookups; matched whole-object.
      // ISS-9112: the whole population rides one read.
      expect(
        sessionDetailReadMocks.readAgentSessionDetailInputs
      ).toHaveBeenCalledWith(
        { organizationId, ids: ["sess-a", "sess-b", "sess-c"] },
        { includeActivitySegments: false, includeAuthoritativeCost: false }
      );
    });

    it("excludes reviewed participation links from the merged trace lookup", async () => {
      mockLinkedSessions(["review-session"]);
      mockDb.artifactLink.findMany.mockResolvedValue([
        {
          branchParticipation: BranchParticipationKind.Reviewed,
          createdAt: now,
          id: "link-review-session",
          metadata: {},
          sourceId: "review-session",
          source: {
            id: "review-session",
            name: "session review-session",
            session: {
              artifactId: "review-session",
              externalSessionId: "review-session",
            },
            slug: "SES-0",
          },
        },
      ]);

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 50, offset: 0 }
      );

      const linkWhere = mockDb.artifactLink.findMany.mock.calls[0]?.[0]?.where;
      expect(linkWhere).toMatchObject({
        AND: expect.arrayContaining([
          {
            OR: expect.arrayContaining([
              { branchParticipation: BranchParticipationKind.Wrote },
              { branchParticipation: null },
            ]),
          },
        ]),
      });
      expect(response?.items).toEqual([]);
      expect(
        sessionDetailReadMocks.readAgentSessionDetailInputs
      ).toHaveBeenCalledWith(
        { ids: [], organizationId },
        {
          includeActivitySegments: false,
          includeAuthoritativeCost: false,
          signal: undefined,
        }
      );
    });

    it("preserves item pagination for an uncapped Session population", async () => {
      mockLinkedSessions(["sess-a", "sess-b", "sess-c"]);

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 1, offset: 1 }
      );

      expect(response?.items).toHaveLength(1);
      expect(response?.items[0]?.sessionId).toBe("sess-b");
      expect(response?.hasMore).toBe(true);
      // ISS-9112: paging the ITEMS does not page the hydration, and the
      // hydration is one read for the three linked sessions rather than three.
      expect(
        sessionDetailReadMocks.readAgentSessionDetailInputs
      ).toHaveBeenCalledTimes(1);
    });

    it("returns null without hydrating sessions when the branch is not visible", async () => {
      mockDb.artifact.findFirst.mockResolvedValue(null);

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 50, offset: 0 }
      );

      expect(response).toBeNull();
      expect(
        sessionDetailReadMocks.readAgentSessionDetailInputs
      ).not.toHaveBeenCalled();
    });

    it("hands the caller's signal to the batched read, and lets an abort during it propagate", async () => {
      mockLinkedSessions(["sess-a", "sess-b"]);
      const controller = new AbortController();
      // The reader is chunked, so an abort that lands after its first chunk
      // surfaces from INSIDE the read — not from a check around it.
      sessionDetailReadMocks.readAgentSessionDetailInputs.mockImplementation(
        () => {
          controller.abort();
          return Promise.reject(controller.signal.reason);
        }
      );

      await expect(
        branchReadService.getBranchTrace(
          organizationId,
          branchId,
          { limit: 50, offset: 0 },
          controller.signal
        )
      ).rejects.toThrow();

      // An abort is the caller leaving, not the population becoming
      // unavailable, so it must not be folded into a served trace.
      expect(
        sessionDetailReadMocks.readAgentSessionDetailInputs
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ signal: controller.signal })
      );
    });

    it("filters orphaned links at the query boundary so only valid sessions qualify", async () => {
      mockLinkedSessions(["sess-a"]);

      await branchReadService.getBranchTrace(organizationId, branchId, {
        limit: 50,
        offset: 0,
      });

      const linkWhere = mockDb.artifactLink.findMany.mock.calls[0]?.[0]?.where;
      expect(linkWhere?.source).toMatchObject({ session: { isNot: null } });
    });

    it("skips a link whose source session failed to hydrate rather than tracing a raw sourceId", async () => {
      mockDb.artifact.findFirst.mockResolvedValue(
        makeBranchRow({ firstPushedAt: now })
      );
      mockDb.artifactLink.findMany.mockResolvedValue([
        {
          id: "link-valid",
          sourceId: "valid-sess",
          createdAt: now,
          source: {
            id: "valid-sess",
            name: "valid",
            slug: "SES-valid",
            session: {
              artifactId: "valid-sess",
              externalSessionId: "valid-sess",
            },
          },
        },
        {
          id: "link-orphan",
          sourceId: "orphan",
          createdAt: now,
          source: {
            id: "orphan",
            name: "orphan",
            slug: "SES-orphan",
            session: null,
          },
        },
      ]);
      sessionDetailReadMocks.readAgentSessionDetailInputs.mockImplementation(
        async ({ ids: requested }: { ids: string[] }) =>
          requested.flatMap((id) =>
            id === "valid-sess" ? [{ record: { artifactId: id } }] : []
          )
      );
      sessionDetailReadMocks.projectAgentSessionDetail.mockImplementation(
        ({ record }: { record: { artifactId: string } }) => ({
          id: record.artifactId,
          name: "valid",
          primaryModel: null,
          model: null,
          harness: "claude",
          startedAt: now,
          turnItems: [],
        })
      );

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 50, offset: 0 }
      );

      expect(response?.items.map((item) => item.sessionId)).toEqual([
        "valid-sess",
      ]);
    });
  });
});
