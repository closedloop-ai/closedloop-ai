import {
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it, vi } from "vitest";
import {
  getSessionUsageByBranch,
  type SessionUsageClient,
  type SessionUsageDateWindow,
  sessionUsageDateWindow,
  tokenEventInDateWindow,
  windowedSpendBySession,
} from "./session-usage-window";

describe("sessionUsageDateWindow", () => {
  it("stamps a cache scope key from evaluationNow when the caller supplies one", () => {
    const window = sessionUsageDateWindow({
      evaluationNow: new Date("2026-08-20T12:00:00.000Z"),
      startDate: new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(window).toEqual({
      cacheScopeKey: "2026-08-20T12:00:00.000Z",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: undefined,
    });
  });

  it("omits the cache scope key when no evaluationNow is supplied", () => {
    const window = sessionUsageDateWindow({
      startDate: new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(window).toEqual({
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: undefined,
    });
    expect(Object.hasOwn(window ?? {}, "cacheScopeKey")).toBe(false);
  });
});

describe("tokenEventInDateWindow", () => {
  const startDate = new Date("2026-08-01T00:00:00.000Z");
  const endDate = new Date("2026-08-10T00:00:00.000Z");

  it("treats an unbounded window as always in-window", () => {
    expect(
      tokenEventInDateWindow(new Date("2026-01-01T00:00:00.000Z"), {})
    ).toBe(true);
  });

  it("excludes a null event timestamp once a window is active", () => {
    expect(tokenEventInDateWindow(null, { startDate })).toBe(false);
  });

  it("excludes a null event timestamp under an end-only window", () => {
    expect(tokenEventInDateWindow(null, { endDate })).toBe(false);
  });

  it("excludes an event before the start bound", () => {
    expect(
      tokenEventInDateWindow(new Date("2026-07-31T23:59:59.000Z"), {
        startDate,
      })
    ).toBe(false);
  });

  it("includes an event exactly on the start bound (inclusive)", () => {
    expect(tokenEventInDateWindow(startDate, { startDate })).toBe(true);
  });

  it("includes an event on/after an open-ended start bound", () => {
    expect(
      tokenEventInDateWindow(new Date("2026-08-05T00:00:00.000Z"), {
        startDate,
      })
    ).toBe(true);
  });

  it("excludes an event after the end bound", () => {
    expect(
      tokenEventInDateWindow(new Date("2026-08-11T00:00:00.000Z"), { endDate })
    ).toBe(false);
  });

  it("includes an event exactly on the end bound (inclusive)", () => {
    expect(tokenEventInDateWindow(endDate, { endDate })).toBe(true);
  });

  it("includes an event inside both bounds", () => {
    expect(
      tokenEventInDateWindow(new Date("2026-08-05T00:00:00.000Z"), {
        startDate,
        endDate,
      })
    ).toBe(true);
  });

  it("excludes an event before the start bound even when an end bound is also set", () => {
    expect(
      tokenEventInDateWindow(new Date("2026-07-01T00:00:00.000Z"), {
        startDate,
        endDate,
      })
    ).toBe(false);
  });
});

describe("windowedSpendBySession", () => {
  it("sums only in-window events and drops out-of-window ones from the fold", () => {
    const dateWindow: SessionUsageDateWindow = {
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-10T00:00:00.000Z"),
    };

    const result = windowedSpendBySession(
      [
        {
          agentSessionId: "session-1",
          eventCreatedAt: new Date("2026-08-05T00:00:00.000Z"),
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCost: 2,
        },
        {
          agentSessionId: "session-1",
          eventCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
          inputTokens: 999,
          outputTokens: 999,
          cacheReadTokens: 999,
          cacheWriteTokens: 999,
          estimatedCost: 999,
        },
      ],
      dateWindow
    );

    expect(result.get("session-1")).toEqual({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 2,
      hasPricedCost: true,
    });
  });
});

describe("getSessionUsageByBranch — participation merge across duplicate evidence", () => {
  it("upgrades a session row to Wrote when a later link on the same session carries Wrote", async () => {
    const db = {
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([
          // First evidence: no explicit participation and no relation/method
          // evidence, so `branchParticipationForLink` resolves undefined and
          // the row is created without a `participation` field.
          makeLink({ branchParticipation: null, metadata: {} }),
          // Duplicate evidence for the SAME session: explicit Wrote. This must
          // reach the `existingSession` branch and upgrade the stored row.
          makeLink({ branchParticipation: BranchParticipationKind.Wrote }),
        ]),
      },
      agentSessionTokenEvent: { findMany: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as SessionUsageClient;

    const usage = (
      await getSessionUsageByBranch(db, "org-1", ["branch-1"])
    ).get("branch-1");

    expect(usage?.sessions).toHaveLength(1);
    expect(usage?.sessions[0]?.participation).toBe(
      BranchParticipationKind.Wrote
    );
    expect(db.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          targetId: { in: ["branch-1"] },
        }),
      })
    );
  });
});

describe("getSessionUsageByBranch — session row shape", () => {
  it("omits externalSessionId from the session row when the persisted value is empty", async () => {
    const db = {
      artifactLink: {
        findMany: vi
          .fn()
          .mockResolvedValue([makeLink({ externalSessionId: "" })]),
      },
      agentSessionTokenEvent: { findMany: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as SessionUsageClient;

    const usage = (
      await getSessionUsageByBranch(db, "org-2", ["branch-1"])
    ).get("branch-1");

    expect(usage?.sessions).toHaveLength(1);
    expect(Object.hasOwn(usage?.sessions[0] ?? {}, "externalSessionId")).toBe(
      false
    );
    expect(db.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-2" }),
      })
    );
  });
});

describe("getSessionUsageByBranch — lifecycle event dedupe across links", () => {
  it("drops a lifecycle event already recorded under an identical identity from a prior link", async () => {
    const sharedEvent = {
      kind: BranchLifecycleBoundaryKind.PrRaised,
      observedAt: "2026-06-10T10:01:00.000Z",
      evidenceId: "pr",
    };
    const newEvent = {
      kind: BranchLifecycleBoundaryKind.BranchWrite,
      observedAt: "2026-06-10T10:04:00.000Z",
      evidenceId: "write",
    };
    const db = {
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([
          makeLink({
            branchParticipation: BranchParticipationKind.Wrote,
            branchLifecycleEvents: [sharedEvent],
          }),
          makeLink({
            branchParticipation: BranchParticipationKind.Wrote,
            branchLifecycleEvents: [sharedEvent, newEvent],
          }),
        ]),
      },
      agentSessionTokenEvent: { findMany: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as SessionUsageClient;

    const usage = (
      await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
        includeLifecycleEvents: true,
      })
    ).get("branch-1");

    const events = usage?.lifecycleEventsBySession?.get("session-1");
    // The duplicate `sharedEvent` from the second link must not be appended a
    // second time — only the genuinely new `write` boundary joins it.
    expect(events).toHaveLength(2);
    expect(events?.map((event) => event.evidenceId)).toEqual(["pr", "write"]);
    expect(
      usage?.sessions[0]?.phaseSegments?.map(({ phase }) => phase)
    ).toEqual([BranchLifecyclePhase.Build, BranchLifecyclePhase.Rework]);
    expect(db.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-1" }),
      })
    );
  });
});

function makeLink(
  overrides: {
    branchParticipation?: BranchParticipationKind | null;
    metadata?: Record<string, unknown>;
    externalSessionId?: string;
    branchLifecycleEvents?: readonly {
      kind: BranchLifecycleBoundaryKind;
      observedAt: string;
      evidenceId: string;
    }[];
  } = {}
) {
  const branchParticipation =
    overrides.branchParticipation === undefined
      ? BranchParticipationKind.Wrote
      : overrides.branchParticipation;
  const metadata =
    overrides.metadata ??
    (overrides.branchLifecycleEvents
      ? {
          linkKind: SessionArtifactLinkKind.SessionPr,
          branchLifecycleEvents: overrides.branchLifecycleEvents,
        }
      : { linkKind: SessionArtifactLinkKind.SessionBranch });
  return {
    targetId: "branch-1",
    sourceId: "session-1",
    branchParticipation,
    branchParticipationMethod: null,
    branchParticipationObservedAt: null,
    metadata,
    source: {
      name: "Canonical session",
      slug: "canonical-session",
      status: SESSION_STATUS.ACTIVE,
      session: {
        artifactId: "session-1",
        externalSessionId: overrides.externalSessionId ?? "session-1",
        harness: "claude",
        sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
        sessionEndedAt: null,
        lastActivityAt: new Date("2026-06-10T10:00:00.000Z"),
        estimatedCost: 3,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turns: null,
        toolUseCount: 0,
        componentInvocationCount: 0,
        billingMode: null,
      },
    },
  };
}
