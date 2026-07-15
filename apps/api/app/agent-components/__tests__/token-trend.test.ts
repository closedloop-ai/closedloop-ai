/**
 * Unit tests for analyticsService.fetchTokenTrend (T-18.4, AC-018, AC-025).
 *
 * Prisma is fully mocked. Tests assert:
 *   - slug parsing: valid `kind::key` returns data; invalid slug returns null
 *   - org-scoping: sessions from a different org are excluded
 *   - per-(model, session) aggregation grouping
 *   - two distinct models produce two points per session
 *   - chronological ordering of points by sessionStartedAt
 *   - empty points returned when no usage rows found for a valid slug
 *   - runtimeMs sourced from usageRollup.runtimeMs (preferred) then fallback
 *   - models list is deduplicated and sorted
 *   - userId / since / until query filters are forwarded to Prisma
 *   - componentInvocations and componentErrorCount carry through
 *   - time-bucketing: sessions on different days remain as distinct data points
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @repo/database BEFORE importing the service under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import { analyticsService } from "../analytics-service";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG = "org-trend-1111";
const ORG_B = "org-trend-2222";
const SESSION_1 = "session-trend-aaaa";
const SESSION_2 = "session-trend-bbbb";
const SESSION_3 = "session-trend-cccc";

const MODEL_CLAUDE = "claude-opus-4-5";
const MODEL_SONNET = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

type TokenUsageByModel = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

type UsageRollup = { runtimeMs: number | null } | null;

type SessionFixture = {
  artifactId: string;
  sessionStartedAt: Date;
  sessionEndedAt?: Date | null;
  artifact: { organizationId: string };
  tokenUsageByModel: TokenUsageByModel[];
  usageRollup: UsageRollup;
};

type UsageRowFixture = {
  agentSessionId: string;
  componentKey: string;
  invocationCount: number;
  errorCount: number;
  session: SessionFixture;
};

function makeSession(overrides: {
  artifactId: string;
  sessionStartedAt: Date;
  sessionEndedAt?: Date;
  organizationId?: string;
  tokenUsageByModel?: TokenUsageByModel[];
  runtimeMs?: number | null;
}): SessionFixture {
  return {
    artifactId: overrides.artifactId,
    sessionStartedAt: overrides.sessionStartedAt,
    sessionEndedAt: overrides.sessionEndedAt ?? null,
    artifact: { organizationId: overrides.organizationId ?? ORG },
    tokenUsageByModel: overrides.tokenUsageByModel ?? [],
    usageRollup:
      overrides.runtimeMs === undefined
        ? null
        : { runtimeMs: overrides.runtimeMs },
  };
}

function makeUsageRow(overrides: {
  agentSessionId: string;
  componentKey?: string;
  invocationCount?: number;
  errorCount?: number;
  session: SessionFixture;
}): UsageRowFixture {
  return {
    agentSessionId: overrides.agentSessionId,
    componentKey: overrides.componentKey ?? "general-purpose",
    invocationCount: overrides.invocationCount ?? 1,
    errorCount: overrides.errorCount ?? 0,
    session: overrides.session,
  };
}

function makeTokenUsage(overrides: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
}): TokenUsageByModel {
  return {
    model: overrides.model,
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 500,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    estimatedCost: overrides.estimatedCost ?? 0.01,
  };
}

type MockDb = {
  agentComponentSessionUsage: { findMany: ReturnType<typeof vi.fn> };
};

function installDb(usageRows: UsageRowFixture[]): void {
  const db: MockDb = {
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue(usageRows),
    },
  };

  mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
    callback(db)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyticsService.fetchTokenTrend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("slug parsing", () => {
    it("returns null when slug has no '::' separator (invalid format)", async () => {
      installDb([]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "invalid-slug",
        {}
      );

      expect(result).toBeNull();
    });

    it("returns null for empty string slug", async () => {
      installDb([]);

      const result = await analyticsService.fetchTokenTrend(ORG, "", {});

      expect(result).toBeNull();
    });

    it("parses a valid kind::key slug and queries the DB with correct fields", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      mocks.withDb.mockImplementation(
        (
          cb: (db: {
            agentComponentSessionUsage: { findMany: typeof findMany };
          }) => unknown
        ) => cb({ agentComponentSessionUsage: { findMany } })
      );

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::code-review",
        {}
      );

      expect(result).not.toBeNull();
      expect(result?.slug).toBe("command::code-review");
      expect(result?.points).toHaveLength(0);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            componentKind: "command",
            componentKey: "code-review",
          }),
        })
      );
    });

    it("returns empty points array when slug is valid but no usage rows exist", async () => {
      installDb([]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "skill::test-runner",
        {}
      );

      expect(result?.slug).toBe("skill::test-runner");
      expect(result?.points).toHaveLength(0);
      expect(result?.models).toHaveLength(0);
    });
  });

  describe("org-scoping", () => {
    it("excludes sessions belonging to a different org", async () => {
      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          invocationCount: 5,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
            organizationId: ORG_B, // different org — must be excluded
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG, // querying as ORG
        "command::build",
        {}
      );

      expect(result?.points).toHaveLength(0);
      expect(result?.models).toHaveLength(0);
    });

    it("includes sessions belonging to the calling org", async () => {
      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          invocationCount: 3,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 2000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      expect(result?.points).toHaveLength(1);
    });
  });

  describe("per-(model, session) aggregation", () => {
    it("produces one point per (session × model) pair for a single session with two models", async () => {
      const sessionStartedAt = new Date("2026-06-10T09:00:00Z");

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          invocationCount: 4,
          errorCount: 1,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt,
            organizationId: ORG,
            tokenUsageByModel: [
              makeTokenUsage({
                model: MODEL_CLAUDE,
                inputTokens: 2000,
                outputTokens: 800,
                estimatedCost: 0.05,
              }),
              makeTokenUsage({
                model: MODEL_SONNET,
                inputTokens: 1000,
                outputTokens: 400,
                estimatedCost: 0.02,
              }),
            ],
            runtimeMs: 3000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      expect(result?.points).toHaveLength(2); // one per model
      const claudePoint = result?.points.find((p) => p.model === MODEL_CLAUDE);
      const sonnetPoint = result?.points.find((p) => p.model === MODEL_SONNET);

      expect(claudePoint).toBeDefined();
      expect(claudePoint?.sessionId).toBe(SESSION_1);
      expect(claudePoint?.inputTokens).toBe(2000);
      expect(claudePoint?.outputTokens).toBe(800);
      expect(claudePoint?.estimatedCostUsd).toBeCloseTo(0.05);
      expect(claudePoint?.componentInvocations).toBe(4);
      expect(claudePoint?.componentErrorCount).toBe(1);
      expect(claudePoint?.runtimeMs).toBe(3000);

      expect(sonnetPoint?.inputTokens).toBe(1000);
    });

    it("FEA-2990: collapses a session's per-branch usage rows to one point (no token double-count)", async () => {
      // The same component ran on two branches within ONE session, so the
      // desktop materialized two usage rows (feat/a, feat/b) that both reference
      // the SAME session (identical token/runtime aggregates). Token/runtime are
      // session-level, so the trend must emit ONE point per (session, model) with
      // the component invocation counts SUMMED — not two points double-counting
      // the session's tokens. Pre-collapse code emitted a point per usage row.
      const sessionStartedAt = new Date("2026-06-11T09:00:00Z");
      const branchARow = makeUsageRow({
        agentSessionId: SESSION_1,
        invocationCount: 4,
        errorCount: 1,
        session: makeSession({
          artifactId: SESSION_1,
          sessionStartedAt,
          organizationId: ORG,
          tokenUsageByModel: [
            makeTokenUsage({
              model: MODEL_CLAUDE,
              inputTokens: 2000,
              outputTokens: 800,
              estimatedCost: 0.05,
            }),
          ],
          runtimeMs: 3000,
        }),
      });
      // Second branch row: same session, same token aggregates, more invocations.
      const branchBRow = makeUsageRow({
        agentSessionId: SESSION_1,
        invocationCount: 9,
        errorCount: 2,
        session: makeSession({
          artifactId: SESSION_1,
          sessionStartedAt,
          organizationId: ORG,
          tokenUsageByModel: [
            makeTokenUsage({
              model: MODEL_CLAUDE,
              inputTokens: 2000,
              outputTokens: 800,
              estimatedCost: 0.05,
            }),
          ],
          runtimeMs: 3000,
        }),
      });

      installDb([branchARow, branchBRow]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "tool::Bash",
        {}
      );

      // ONE point for the one (session, model) — not two.
      expect(result?.points).toHaveLength(1);
      const point = result?.points[0];
      expect(point?.sessionId).toBe(SESSION_1);
      // Tokens counted once (not doubled to 4000/1600).
      expect(point?.inputTokens).toBe(2000);
      expect(point?.outputTokens).toBe(800);
      expect(point?.estimatedCostUsd).toBeCloseTo(0.05);
      // Component invocation/error counts summed across the two branch buckets.
      expect(point?.componentInvocations).toBe(13);
      expect(point?.componentErrorCount).toBe(3);
    });

    it("produces two points from two sessions both using the same model", async () => {
      const t1 = new Date("2026-06-01T10:00:00Z");
      const t2 = new Date("2026-06-02T10:00:00Z");

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: t1,
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
        makeUsageRow({
          agentSessionId: SESSION_2,
          session: makeSession({
            artifactId: SESSION_2,
            sessionStartedAt: t2,
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 2000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "skill::test-runner",
        {}
      );

      expect(result?.points).toHaveLength(2);
    });
  });

  describe("chronological ordering", () => {
    it("sorts points by sessionStartedAt ascending", async () => {
      const t1 = new Date("2026-06-03T10:00:00Z");
      const t2 = new Date("2026-06-01T10:00:00Z"); // earlier
      const t3 = new Date("2026-06-02T10:00:00Z"); // middle

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: t1,
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 500,
          }),
        }),
        makeUsageRow({
          agentSessionId: SESSION_2,
          session: makeSession({
            artifactId: SESSION_2,
            sessionStartedAt: t2,
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 500,
          }),
        }),
        makeUsageRow({
          agentSessionId: SESSION_3,
          session: makeSession({
            artifactId: SESSION_3,
            sessionStartedAt: t3,
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 500,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      const timestamps = result?.points.map((p) => p.sessionStartedAt) ?? [];
      expect(timestamps[0]).toBe(t2.toISOString()); // earliest first
      expect(timestamps[1]).toBe(t3.toISOString());
      expect(timestamps[2]).toBe(t1.toISOString());
    });
  });

  describe("runtimeMs derivation", () => {
    it("uses usageRollup.runtimeMs when available", async () => {
      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
            sessionEndedAt: new Date("2026-06-01T10:10:00Z"), // 10 min diff
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 5000, // authoritative rollup value
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      expect(result?.points[0]?.runtimeMs).toBe(5000); // rollup wins over wall-clock diff
    });

    it("falls back to sessionEndedAt - sessionStartedAt when rollup is absent", async () => {
      // Build a custom session fixture without runtimeMs
      const startedAt = new Date("2026-06-01T10:00:00Z");
      const endedAt = new Date("2026-06-01T10:02:00Z"); // 2 minutes = 120_000 ms

      const sessionWithoutRollup: SessionFixture = {
        artifactId: SESSION_1,
        sessionStartedAt: startedAt,
        sessionEndedAt: endedAt,
        artifact: { organizationId: ORG },
        tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
        usageRollup: null, // no rollup
      };

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          session: sessionWithoutRollup,
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      expect(result?.points[0]?.runtimeMs).toBe(120_000);
    });

    it("returns null for runtimeMs when neither rollup nor sessionEndedAt is available", async () => {
      const sessionNoEndNoRollup: SessionFixture = {
        artifactId: SESSION_1,
        sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
        sessionEndedAt: null,
        artifact: { organizationId: ORG },
        tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
        usageRollup: null,
      };

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          session: sessionNoEndNoRollup,
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      expect(result?.points[0]?.runtimeMs).toBeNull();
    });
  });

  describe("models list", () => {
    it("returns deduplicated sorted models list", async () => {
      const startedAt = new Date("2026-06-01T10:00:00Z");

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: startedAt,
            organizationId: ORG,
            tokenUsageByModel: [
              makeTokenUsage({ model: MODEL_SONNET }),
              makeTokenUsage({ model: MODEL_CLAUDE }),
            ],
            runtimeMs: 1000,
          }),
        }),
        makeUsageRow({
          agentSessionId: SESSION_2,
          session: makeSession({
            artifactId: SESSION_2,
            sessionStartedAt: new Date("2026-06-02T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [
              makeTokenUsage({ model: MODEL_CLAUDE }), // duplicate
            ],
            runtimeMs: 500,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "skill::eval",
        {}
      );

      // Two unique models, sorted alphabetically
      expect(result?.models).toHaveLength(2);
      expect(result?.models).toEqual([MODEL_CLAUDE, MODEL_SONNET].sort());
    });
  });

  describe("query filters forwarded to Prisma", () => {
    it("includes userId filter in the Prisma where clause when provided", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      mocks.withDb.mockImplementation(
        (
          cb: (db: {
            agentComponentSessionUsage: { findMany: typeof findMany };
          }) => unknown
        ) => cb({ agentComponentSessionUsage: { findMany } })
      );

      await analyticsService.fetchTokenTrend(ORG, "command::build", {
        userId: "user-abc",
      });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            session: expect.objectContaining({ userId: "user-abc" }),
          }),
        })
      );
    });

    it("includes since/until date filters in the Prisma where clause when provided", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      mocks.withDb.mockImplementation(
        (
          cb: (db: {
            agentComponentSessionUsage: { findMany: typeof findMany };
          }) => unknown
        ) => cb({ agentComponentSessionUsage: { findMany } })
      );

      await analyticsService.fetchTokenTrend(ORG, "command::build", {
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-30T23:59:59Z",
      });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            session: expect.objectContaining({
              sessionStartedAt: expect.objectContaining({
                gte: expect.any(Date),
                lte: expect.any(Date),
              }),
            }),
          }),
        })
      );
    });

    it("omits date filter when neither since nor until is provided", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      mocks.withDb.mockImplementation(
        (
          cb: (db: {
            agentComponentSessionUsage: { findMany: typeof findMany };
          }) => unknown
        ) => cb({ agentComponentSessionUsage: { findMany } })
      );

      await analyticsService.fetchTokenTrend(ORG, "command::build", {});

      const [call] = findMany.mock.calls;
      const where = (call?.[0] as { where?: { session?: unknown } })?.where
        ?.session;
      expect(where).not.toHaveProperty("sessionStartedAt");
    });
  });

  describe("time-bucketing (sessions on different days)", () => {
    it("sessions on different calendar days appear as distinct points (not merged)", async () => {
      // Day 1 and Day 2 — both with the same model
      const day1 = new Date("2026-06-01T14:00:00Z");
      const day2 = new Date("2026-06-02T14:00:00Z");

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          invocationCount: 3,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: day1,
            organizationId: ORG,
            tokenUsageByModel: [
              makeTokenUsage({ model: MODEL_CLAUDE, inputTokens: 1000 }),
            ],
            runtimeMs: 1000,
          }),
        }),
        makeUsageRow({
          agentSessionId: SESSION_2,
          invocationCount: 7,
          session: makeSession({
            artifactId: SESSION_2,
            sessionStartedAt: day2,
            organizationId: ORG,
            tokenUsageByModel: [
              makeTokenUsage({ model: MODEL_CLAUDE, inputTokens: 2000 }),
            ],
            runtimeMs: 1500,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      // Two sessions on two days → two distinct points (no merging by day)
      expect(result?.points).toHaveLength(2);

      const day1Point = result?.points.find((p) => p.sessionId === SESSION_1);
      const day2Point = result?.points.find((p) => p.sessionId === SESSION_2);

      expect(day1Point?.inputTokens).toBe(1000);
      expect(day1Point?.componentInvocations).toBe(3);

      expect(day2Point?.inputTokens).toBe(2000);
      expect(day2Point?.componentInvocations).toBe(7);
    });
  });

  describe("FEA-3052: subagent rollup parity with the listing", () => {
    it("broadens the Prisma where for the rolled-up general-purpose subagent slug", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      mocks.withDb.mockImplementation(
        (
          cb: (db: {
            agentComponentSessionUsage: { findMany: typeof findMany };
          }) => unknown
        ) => cb({ agentComponentSessionUsage: { findMany } })
      );

      await analyticsService.fetchTokenTrend(
        ORG,
        "subagent::general-purpose",
        {}
      );

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            componentKind: "subagent",
            OR: [
              { componentKey: "general-purpose" },
              {
                componentKey: {
                  startsWith: "claude subagent ",
                  mode: "insensitive",
                },
              },
            ],
          }),
        })
      );
    });

    it("keeps an exact componentKey match for a typed (non-rolled-up) subagent slug", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      mocks.withDb.mockImplementation(
        (
          cb: (db: {
            agentComponentSessionUsage: { findMany: typeof findMany };
          }) => unknown
        ) => cb({ agentComponentSessionUsage: { findMany } })
      );

      await analyticsService.fetchTokenTrend(
        ORG,
        "subagent::code-reviewer",
        {}
      );

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            componentKind: "subagent",
            componentKey: "code-reviewer",
          }),
        })
      );
    });

    it("folds instance-unique 'Claude subagent <hex>' rows into the general-purpose trend", async () => {
      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          componentKey: "general-purpose",
          invocationCount: 2,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
        makeUsageRow({
          agentSessionId: SESSION_2,
          componentKey: "Claude subagent ab12cd34",
          invocationCount: 5,
          session: makeSession({
            artifactId: SESSION_2,
            sessionStartedAt: new Date("2026-06-02T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 2000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "subagent::general-purpose",
        {}
      );

      // Both the literal general-purpose row and the instance-unique row surface.
      expect(result?.points.map((p) => p.sessionId).sort()).toEqual(
        [SESSION_1, SESSION_2].sort()
      );
    });

    it("drops stale instance-alias rows for a re-synced session that also has the general-purpose rollup (no double-count)", async () => {
      // One session synced pre-rollup (instance-unique alias, 5 invocations) and
      // later re-synced by a desktop that emits the authoritative
      // `general-purpose` rollup (2 invocations). `persistSessionComponentUsage`
      // only prunes branch buckets within the exact componentKey, so the stale
      // alias row survives under a different key. The rollup row is
      // authoritative — the alias must be dropped, not summed.
      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          componentKey: "general-purpose",
          invocationCount: 2,
          errorCount: 1,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
        makeUsageRow({
          agentSessionId: SESSION_1,
          componentKey: "Claude subagent ab12cd34",
          invocationCount: 5,
          errorCount: 3,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "subagent::general-purpose",
        {}
      );

      // A single point for the session, counting only the authoritative rollup
      // row (2 invocations / 1 error) — the stale alias's 5/3 are not summed in.
      expect(result?.points).toHaveLength(1);
      expect(result?.points[0]?.sessionId).toBe(SESSION_1);
      expect(result?.points[0]?.componentInvocations).toBe(2);
      expect(result?.points[0]?.componentErrorCount).toBe(1);
    });

    it("drops a 'Claude subagent <non-hex>' startsWith false positive (JS tightening)", async () => {
      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          componentKey: "Claude subagent ab12cd34",
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: new Date("2026-06-01T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
        makeUsageRow({
          // Matches the DB `startsWith` over-match but NOT the exact instance
          // pattern (`zzzz` is not hex), so it must be filtered out in JS.
          agentSessionId: SESSION_2,
          componentKey: "Claude subagent zzzz",
          session: makeSession({
            artifactId: SESSION_2,
            sessionStartedAt: new Date("2026-06-02T10:00:00Z"),
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "subagent::general-purpose",
        {}
      );

      expect(result?.points).toHaveLength(1);
      expect(result?.points[0]?.sessionId).toBe(SESSION_1);
    });
  });

  describe("response envelope", () => {
    it("returns slug, points, and models in the response", async () => {
      const startedAt = new Date("2026-06-01T10:00:00Z");
      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: startedAt,
            organizationId: ORG,
            tokenUsageByModel: [makeTokenUsage({ model: MODEL_CLAUDE })],
            runtimeMs: 1000,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::build",
        {}
      );

      expect(result).toMatchObject({
        slug: "command::build",
        points: expect.any(Array),
        models: expect.any(Array),
      });
    });

    it("populates all required TokenTrendPoint fields", async () => {
      const startedAt = new Date("2026-06-05T12:00:00Z");

      installDb([
        makeUsageRow({
          agentSessionId: SESSION_1,
          invocationCount: 6,
          errorCount: 2,
          session: makeSession({
            artifactId: SESSION_1,
            sessionStartedAt: startedAt,
            organizationId: ORG,
            tokenUsageByModel: [
              makeTokenUsage({
                model: MODEL_CLAUDE,
                inputTokens: 3000,
                outputTokens: 1200,
                cacheReadTokens: 100,
                cacheWriteTokens: 50,
                estimatedCost: 0.08,
              }),
            ],
            runtimeMs: 4500,
          }),
        }),
      ]);

      const result = await analyticsService.fetchTokenTrend(
        ORG,
        "command::deploy",
        {}
      );

      const point = result?.points[0];
      expect(point?.sessionId).toBe(SESSION_1);
      expect(point?.sessionStartedAt).toBe(startedAt.toISOString());
      expect(point?.model).toBe(MODEL_CLAUDE);
      expect(point?.inputTokens).toBe(3000);
      expect(point?.outputTokens).toBe(1200);
      expect(point?.cacheReadTokens).toBe(100);
      expect(point?.cacheWriteTokens).toBe(50);
      expect(point?.estimatedCostUsd).toBeCloseTo(0.08);
      expect(point?.runtimeMs).toBe(4500);
      expect(point?.componentInvocations).toBe(6);
      expect(point?.componentErrorCount).toBe(2);
    });
  });
});
