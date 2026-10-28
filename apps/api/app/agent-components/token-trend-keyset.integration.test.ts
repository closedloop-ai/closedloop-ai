/**
 * ISS-9851: the token-trend keyset predicate, against a real Postgres.
 *
 * The unit suites drive an in-memory double that the SAME change taught the
 * predicate to, so they cannot falsify the translation of
 * `AND: [{ OR: [{ session: { sessionStartedAt: { lt } } },
 * { session: { sessionStartedAt: T }, agentSessionId: { gt } }] }]` beside the
 * sibling `session:` key — nor that a uuid `gt` orders the way the read's
 * `agentSessionId asc` sort does. Only the database can answer those.
 *
 * Deliberately scoped to the PREDICATE rather than a full multi-page walk: a
 * real walk needs more than 40,000 usage rows and their sessions, and the
 * page arithmetic is unit-covered. What is here is the part no double can say.
 *
 * Run against a database with the schema applied:
 *
 *   DATABASE_URL=… pnpm --filter api exec vitest run \
 *     app/agent-components/token-trend-keyset.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyticsService } from "./analytics-service";
import { MAX_TOKEN_TREND_USAGE_ROWS } from "./analytics-validators";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const COMPONENT_KEY = "keyset-build";
const SLUG = `${AgentComponentKind.Command}::${COMPONENT_KEY}`;
const MODEL = "claude-opus-4-5";

/** Newest first. The two tied sessions share one instant, as real ones can. */
const NEWEST_AT = new Date("2026-08-03T00:00:00.000Z");
const TIE_AT = new Date("2026-08-02T00:00:00.000Z");
const OLDEST_AT = new Date("2026-08-01T00:00:00.000Z");
const WINDOW_SINCE = "2026-07-01T00:00:00.000Z";
/** One row per branch is what the unique key permits, so branches are minted. */
const OVERSIZE_BRANCH_PREFIX = "keyset-oversize-";

type Seed = {
  organizationId: string;
  newestSessionId: string;
  tieLowSessionId: string;
  tieHighSessionId: string;
  oldestSessionId: string;
  sessionIds: string[];
};

describe.skipIf(!hasDatabase)("ISS-9851 token-trend keyset predicate", () => {
  let seed: Seed;

  beforeAll(async () => {
    seed = await seedSessions();
  });

  afterAll(async () => {
    await withDb(async (db) => {
      await db.agentComponentSessionUsage.deleteMany({
        where: { agentSessionId: { in: seed.sessionIds } },
      });
      await db.agentSessionTokenUsage.deleteMany({
        where: { agentSessionId: { in: seed.sessionIds } },
      });
      await db.sessionDetail.deleteMany({
        where: { artifactId: { in: seed.sessionIds } },
      });
      await db.artifact.deleteMany({
        where: { organizationId: seed.organizationId },
      });
      await db.computeTarget.deleteMany({
        where: { organizationId: seed.organizationId },
      });
      await db.user.deleteMany({
        where: { organizationId: seed.organizationId },
      });
      await db.organization.deleteMany({ where: { id: seed.organizationId } });
    });
  });

  it("reads every session in the window when no cursor is supplied", async () => {
    const trend = await analyticsService.fetchTokenTrend(
      seed.organizationId,
      SLUG,
      { since: WINDOW_SINCE }
    );

    // Ascending by session start; the tie is ordered by session id, which is
    // the `agentSessionId asc` the read declares.
    expect(trend?.points.map((point) => point.sessionId)).toEqual([
      seed.oldestSessionId,
      seed.tieLowSessionId,
      seed.tieHighSessionId,
      seed.newestSessionId,
    ]);
    expect(trend?.nextCursor).toBeUndefined();
  });

  it("resumes strictly after a session tied on the same instant", async () => {
    // The arm a timestamp-only cursor gets wrong: `tieHigh` started in the SAME
    // millisecond as `tieLow`, so only `agentSessionId > tieLow` can keep it in
    // while keeping `tieLow` itself out.
    const trend = await analyticsService.fetchTokenTrend(
      seed.organizationId,
      SLUG,
      {
        since: WINDOW_SINCE,
        cursor: {
          sessionStartedAtMs: TIE_AT.getTime(),
          agentSessionId: seed.tieLowSessionId,
        },
      }
    );

    expect(trend?.points.map((point) => point.sessionId)).toEqual([
      seed.oldestSessionId,
      seed.tieHighSessionId,
    ]);
  });

  it("resumes after the last tied session by reading only older ones", async () => {
    const trend = await analyticsService.fetchTokenTrend(
      seed.organizationId,
      SLUG,
      {
        since: WINDOW_SINCE,
        cursor: {
          sessionStartedAtMs: TIE_AT.getTime(),
          agentSessionId: seed.tieHighSessionId,
        },
      }
    );

    expect(trend?.points.map((point) => point.sessionId)).toEqual([
      seed.oldestSessionId,
    ]);
  });

  it("returns nothing once the cursor passes the oldest session", async () => {
    const trend = await analyticsService.fetchTokenTrend(
      seed.organizationId,
      SLUG,
      {
        since: WINDOW_SINCE,
        cursor: {
          sessionStartedAtMs: OLDEST_AT.getTime(),
          agentSessionId: seed.oldestSessionId,
        },
      }
    );

    expect(trend?.points).toEqual([]);
    expect(trend?.truncated).toBeUndefined();
  });

  it("keeps the org scope when a cursor is supplied", async () => {
    // The cursor is opaque and unsigned; it is safe only because it narrows a
    // read that is already org-scoped. Another org's id must see nothing.
    const trend = await analyticsService.fetchTokenTrend(randomUUID(), SLUG, {
      since: WINDOW_SINCE,
      cursor: {
        sessionStartedAtMs: TIE_AT.getTime(),
        agentSessionId: seed.tieLowSessionId,
      },
    });

    expect(trend?.points).toEqual([]);
  });

  it("sums a session larger than the ceiling in the database and calls the window whole", async () => {
    // The oldest session grows past the ceiling on its own. The unit double
    // cannot say whether Prisma translates the boundary `groupBy` — a `_sum`
    // under a relation filter on `session` — or the past-the-boundary
    // `findFirst` with the keyset `OR` beside the same `session` key. Only
    // the database can, and it has to say: one point carrying EVERY row's
    // count, and no `truncated`/`nextCursor` over a window that is whole.
    const extraRows = MAX_TOKEN_TREND_USAGE_ROWS + 1;
    await withDb(async (db) => {
      await db.agentComponentSessionUsage.createMany({
        data: Array.from({ length: extraRows }, (_unused, index) => ({
          agentSessionId: seed.oldestSessionId,
          componentKind: AgentComponentKind.Command,
          componentKey: COMPONENT_KEY,
          gitBranch: `${OVERSIZE_BRANCH_PREFIX}${index}`,
          harness: Harness.Claude,
          invocationCount: 1,
          lastInvokedAt: OLDEST_AT,
        })),
      });
    });

    try {
      const trend = await analyticsService.fetchTokenTrend(
        seed.organizationId,
        SLUG,
        { since: WINDOW_SINCE }
      );

      expect(trend?.points.map((point) => point.sessionId)).toEqual([
        seed.oldestSessionId,
        seed.tieLowSessionId,
        seed.tieHighSessionId,
        seed.newestSessionId,
      ]);
      expect(trend?.points[0]?.componentInvocations).toBe(extraRows + 1);
      expect(trend?.truncated).toBeUndefined();
      expect(trend?.nextCursor).toBeUndefined();
    } finally {
      await withDb(async (db) => {
        await db.agentComponentSessionUsage.deleteMany({
          where: {
            agentSessionId: seed.oldestSessionId,
            gitBranch: { startsWith: OVERSIZE_BRANCH_PREFIX },
          },
        });
      });
    }
  });
});

/**
 * One org and four sessions: one newest, two sharing a single
 * `session_started_at`, and one oldest. The tied pair's ids are sorted so the
 * fixture knows which one a uuid comparison puts first.
 */
async function seedSessions(): Promise<Seed> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const computeTargetId = randomUUID();
  const newestSessionId = randomUUID();
  const oldestSessionId = randomUUID();
  const [tieLowSessionId, tieHighSessionId] = [
    randomUUID(),
    randomUUID(),
  ].sort();
  const sessionIds = [
    newestSessionId,
    tieLowSessionId,
    tieHighSessionId,
    oldestSessionId,
  ];

  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: organizationId,
        clerkId: `clerk-${organizationId}`,
        name: "Token trend keyset org",
        slug: `token-trend-keyset-${organizationId}`,
      },
      select: { id: true },
    });
    await db.user.create({
      data: {
        id: userId,
        clerkId: `clerk-user-${userId}`,
        organizationId,
        email: `${userId}@example.com`,
      },
      select: { id: true },
    });
    await db.computeTarget.create({
      data: {
        id: computeTargetId,
        organizationId,
        userId,
        machineName: "token-trend-keyset",
        platform: "darwin",
      },
      select: { id: true },
    });

    for (const [sessionId, startedAt] of [
      [newestSessionId, NEWEST_AT],
      [tieLowSessionId, TIE_AT],
      [tieHighSessionId, TIE_AT],
      [oldestSessionId, OLDEST_AT],
    ] as const) {
      await db.artifact.create({
        data: {
          id: sessionId,
          organizationId,
          type: ArtifactType.Session,
          name: `session-${sessionId}`,
          status: SESSION_STATUS.ACTIVE,
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: sessionId,
          computeTargetId,
          externalSessionId: `ext-${sessionId}`,
          harness: Harness.Claude,
          sessionStartedAt: startedAt,
          sessionUpdatedAt: startedAt,
          lastActivityAt: startedAt,
        },
        select: { artifactId: true },
      });
      await db.agentSessionTokenUsage.create({
        data: {
          agentSessionId: sessionId,
          model: MODEL,
          inputTokens: 1000,
          outputTokens: 500,
          estimatedCost: "0.010000",
        },
        select: { id: true },
      });
      await db.agentComponentSessionUsage.create({
        data: {
          agentSessionId: sessionId,
          componentKind: AgentComponentKind.Command,
          componentKey: COMPONENT_KEY,
          harness: Harness.Claude,
          invocationCount: 1,
          lastInvokedAt: startedAt,
        },
        select: { id: true },
      });
    }
  });

  return {
    organizationId,
    newestSessionId,
    tieLowSessionId,
    tieHighSessionId,
    oldestSessionId,
    sessionIds,
  };
}
