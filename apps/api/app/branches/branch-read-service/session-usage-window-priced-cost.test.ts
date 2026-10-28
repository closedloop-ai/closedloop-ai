import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  getSessionUsageByBranch,
  type SessionUsageClient,
} from "./session-usage-window";

describe("Branch aggregate-only windowed priced cost", () => {
  it("keeps unwindowed placeholder zero unknown on the fast path", async () => {
    const { db, eventEvidenceQuery, eventGroupBy } = makeAggregateOnlyClient(
      null,
      {
        inputTokens: 0n,
        sessionEstimatedCost: 0,
      }
    );

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"]);

    expect(eventGroupBy).not.toHaveBeenCalled();
    expect(eventEvidenceQuery).not.toHaveBeenCalled();
    expect(usage.get("branch-1")).toMatchObject({
      estimatedCostUsd: 0,
      hasPricedCost: false,
    });
    expect(usage.get("branch-1")?.sessions[0]?.estimatedCostUsd).toBeNull();
  });

  it("keeps an unwindowed worked subscription zero priced without event reads", async () => {
    const { db, eventEvidenceQuery, eventGroupBy } = makeAggregateOnlyClient(
      null,
      {
        billingMode: "max_20x",
        sessionEstimatedCost: 0,
        turns: 1,
      }
    );

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"]);

    expect(eventGroupBy).not.toHaveBeenCalled();
    expect(eventEvidenceQuery).not.toHaveBeenCalled();
    expect(usage.get("branch-1")).toMatchObject({
      estimatedCostUsd: 0,
      hasPricedCost: true,
    });
    expect(usage.get("branch-1")?.sessions[0]?.estimatedCostUsd).toBe(0);
  });

  it("keeps an unwindowed worked subscription UNPRICED when nothing priced it", async () => {
    // ISS-7813. Identical to the case above except the stored cost is null
    // rather than 0 — the distinction the nullable column exists for. That
    // pairing is the point: 0 must stay a measured $0.00 and null must not
    // become one.
    //
    // `numberFromDecimal` folds null to 0, which is right for the token-event
    // field it was written for and wrong for this one. Unguarded, the fold
    // reaches `sessionCostIsNumeric`, which returns true unconditionally for a
    // subscription session that did real work — so a session nobody priced
    // would report a confident, measured-looking $0.00 and flip the branch to
    // priced.
    const { db } = makeAggregateOnlyClient(null, {
      billingMode: "max_20x",
      sessionEstimatedCost: null,
      turns: 1,
    });

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"]);

    expect(usage.get("branch-1")).toMatchObject({ hasPricedCost: false });
    expect(usage.get("branch-1")?.sessions[0]?.estimatedCostUsd).toBeNull();
  });

  it("does not price windowed usage from null-cost token events", async () => {
    const { db, eventEvidenceQuery, eventGroupBy } =
      makeAggregateOnlyClient(null);

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
    });

    expect(eventGroupBy).toHaveBeenCalledOnce();
    expect(eventEvidenceQuery).not.toHaveBeenCalled();
    expect(usage.get("branch-1")).toMatchObject({
      inputTokens: 4,
      estimatedCostUsd: 0,
      hasPricedCost: false,
    });
  });

  it("keeps windowed priced-zero token events priced", async () => {
    const { db, eventEvidenceQuery, eventGroupBy } = makeAggregateOnlyClient(0);

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
    });

    expect(eventGroupBy).toHaveBeenCalledOnce();
    expect(eventEvidenceQuery).not.toHaveBeenCalled();
    expect(usage.get("branch-1")).toMatchObject({
      inputTokens: 4,
      estimatedCostUsd: 0,
      hasPricedCost: true,
    });
  });
});

function makeAggregateOnlyClient(
  eventCost: number | null,
  options: {
    billingMode?: string | null;
    inputTokens?: bigint | number;
    // ISS-7813: `null` is a distinct CASE here, not an unset option — it is the
    // never-priced session. `?? 99` on the value below would swallow it, so the
    // default keys on `undefined` instead.
    sessionEstimatedCost?: number | null;
    turns?: number | null;
  } = {}
) {
  const eventEvidenceQuery = vi.fn();
  const eventGroupBy = vi.fn().mockResolvedValue([aggregateRow(eventCost)]);
  const queryRaw = vi.fn((query) => {
    const sql = capturedSqlText(query);
    if (sql.includes("WITH requested_sessions AS MATERIALIZED")) {
      return eventGroupBy({ where: { eventCreatedAt: {} } });
    }
    if (sql.includes("WITH evidence_size AS MATERIALIZED")) {
      return eventEvidenceQuery(query);
    }
    return Promise.resolve([]);
  });
  const db = {
    $queryRaw: queryRaw,
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([
        {
          targetId: "branch-1",
          sourceId: "session-1",
          branchParticipation: BranchParticipationKind.Wrote,
          branchParticipationMethod: null,
          branchParticipationObservedAt: null,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
          source: {
            name: "Windowed session",
            slug: "windowed-session",
            session: {
              artifactId: "session-1",
              externalSessionId: "external-1",
              harness: "claude",
              sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
              sessionEndedAt: null,
              estimatedCost:
                options.sessionEstimatedCost === undefined
                  ? 99
                  : options.sessionEstimatedCost,
              inputTokens: options.inputTokens ?? 99n,
              outputTokens: 0n,
              cacheReadTokens: 0n,
              cacheWriteTokens: 0n,
              turns: options.turns ?? null,
              toolUseCount: 0,
              billingMode: options.billingMode ?? null,
            },
          },
        },
      ]),
    },
    agentSessionTokenEvent: {
      findMany: vi.fn(),
      groupBy: eventGroupBy,
    },
  } as unknown as SessionUsageClient;
  return { db, eventEvidenceQuery, eventGroupBy };
}

function capturedSqlText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("sql" in query)) {
    return "";
  }
  return String(query.sql);
}

function aggregateRow(eventCost: number | null) {
  return {
    agentSessionId: "session-1",
    _sum: {
      inputTokens: 4n,
      outputTokens: 0n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      estimatedCost: eventCost,
    },
    _min: {
      inputTokens: 4n,
      outputTokens: 0n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      estimatedCost: eventCost,
    },
    _count: { _all: 1, estimatedCost: eventCost === null ? 0 : 1 },
  };
}
