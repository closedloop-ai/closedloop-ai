import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import { RELATED_SESSION_ELIGIBLE_KINDS } from "@repo/api/src/types/provenance-relationship";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByIdSimple: vi.fn(),
  listEligibleSessionContributions: vi.fn(),
  findMany: vi.fn(),
  buildSessionTimelineTrace: vi.fn(),
}));
vi.mock("./document-service", () => ({
  documentService: { findByIdSimple: mocks.findByIdSimple },
}));
vi.mock("@/app/agent-sessions/service/provenance-eligibility", () => ({
  listEligibleSessionContributions: mocks.listEligibleSessionContributions,
}));
vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ sessionDetail: { findMany: mocks.findMany } }),
}));
vi.mock("@/app/branches/branch-trace-service", () => ({
  branchTraceService: {
    buildSessionTimelineTrace: mocks.buildSessionTimelineTrace,
  },
}));

import { documentSessionsService } from "./document-sessions-service";

const complete = { state: BranchTraceCompletenessState.Complete };
const trace = {
  items: [],
  sessions: [],
  qualifyingSessionCount: 0,
  completeness: complete,
  aggregateCompleteness: complete,
};

describe("document Sessions data", () => {
  beforeEach(() => {
    mocks.findByIdSimple.mockResolvedValue({ id: "doc-a" });
    mocks.listEligibleSessionContributions.mockResolvedValue([]);
    mocks.findMany.mockImplementation(
      ({
        where,
      }: {
        where: { artifact?: { is?: { organizationId?: string } } };
      }) => {
        const rows = [
          {
            artifactId: "session-a",
            externalSessionId: "external-a",
            artifact: {
              name: "Session A",
              slug: "SES-1",
              organizationId: "org-a",
            },
          },
          {
            artifactId: "session-b",
            externalSessionId: "external-b",
            artifact: {
              name: "Session B",
              slug: "SES-2",
              organizationId: "org-b",
            },
          },
        ];
        const org = where.artifact?.is?.organizationId;
        return rows.filter(
          (row) => org === undefined || row.artifact.organizationId === org
        );
      }
    );
    mocks.buildSessionTimelineTrace.mockResolvedValue({ trace, details: [] });
  });

  it("does not read provenance when the document is unavailable", async () => {
    mocks.findByIdSimple.mockResolvedValue(null);
    expect(
      await documentSessionsService.readSessions("org-a", "doc-a")
    ).toBeNull();
    expect(mocks.listEligibleSessionContributions).not.toHaveBeenCalled();
  });

  it("uses canonical Related Sessions eligibility and does not impose the eight-chip cap", async () => {
    const contributions = Array.from({ length: 12 }, (_, index) => ({
      sessionArtifactId: `session-${index}`,
      occurredAt: new Date("2026-10-01"),
      kind: RELATED_SESSION_ELIGIBLE_KINDS[0],
    }));
    mocks.listEligibleSessionContributions.mockResolvedValue(contributions);
    mocks.findMany.mockResolvedValue(
      contributions.map((row) => ({
        artifactId: row.sessionArtifactId,
        externalSessionId: row.sessionArtifactId,
        artifact: { name: row.sessionArtifactId, slug: null },
      }))
    );
    await documentSessionsService.readSessions("org-a", "doc-a");
    expect(mocks.listEligibleSessionContributions).toHaveBeenCalledWith({
      organizationId: "org-a",
      artifactId: "doc-a",
    });
    expect(mocks.buildSessionTimelineTrace.mock.calls[0]?.[1]).toHaveLength(12);
    expect(mocks.findMany.mock.calls[0]?.[0]).not.toHaveProperty("take");
  });

  it("org-scopes session identities before they reach trace hydration", async () => {
    mocks.listEligibleSessionContributions.mockResolvedValue(
      ["session-a", "session-b"].map((sessionArtifactId) => ({
        sessionArtifactId,
        occurredAt: new Date("2026-10-01"),
        kind: RELATED_SESSION_ELIGIBLE_KINDS[0],
      }))
    );
    await documentSessionsService.readSessions("org-a", "doc-a");
    expect(
      mocks.buildSessionTimelineTrace.mock.calls[0]?.[1].map(
        (row: { identity: { artifactId: string } }) => row.identity.artifactId
      )
    ).toEqual(["session-a", "session-b"]);
    expect(
      mocks.buildSessionTimelineTrace.mock.calls[0]?.[1][1].identity
    ).toEqual({
      artifactId: "session-b",
      name: null,
      slug: null,
      navigableRef: "session-b",
    });
  });

  it("preserves a qualifying contribution when its identity disappears before hydration", async () => {
    mocks.listEligibleSessionContributions.mockResolvedValue([
      {
        sessionArtifactId: "missing",
        occurredAt: new Date("2026-10-01"),
        kind: RELATED_SESSION_ELIGIBLE_KINDS[0],
      },
    ]);
    mocks.findMany.mockResolvedValue([]);
    await documentSessionsService.readSessions("org-a", "doc-a");
    expect(mocks.buildSessionTimelineTrace).toHaveBeenCalledWith(
      "org-a",
      [
        {
          observedAtMs: new Date("2026-10-01").getTime(),
          identity: {
            artifactId: "missing",
            name: null,
            slug: null,
            navigableRef: "missing",
          },
        },
      ],
      undefined
    );
  });

  it("keeps unavailable sessions in trace evidence and projects real zero cost without branch fields", async () => {
    const partialTrace = {
      ...trace,
      sessions: [
        {
          identity: {
            artifactId: "missing",
            name: null,
            slug: null,
            navigableRef: "missing",
          },
          state: BranchTraceSessionHydrationState.Unavailable,
        },
      ],
      qualifyingSessionCount: 2,
    };
    mocks.buildSessionTimelineTrace.mockResolvedValue({
      trace: partialTrace,
      details: [
        {
          id: "loaded",
          slug: "SES-3",
          name: "Loaded",
          externalSessionId: "external",
          harness: "codex",
          startedAt: new Date("2026-10-01"),
          endedAt: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCost: 0,
          user: null,
        },
      ],
    });
    const result = await documentSessionsService.readSessions("org-a", "doc-a");
    expect(result?.detail.sessions).toHaveLength(1);
    expect(result?.detail.attributedCostUsd).toBe(0);
    expect(result?.detail).not.toHaveProperty("prNumber");
    expect(result?.detail).not.toHaveProperty("commits");
    expect(result?.trace).toEqual(partialTrace);
  });
});
