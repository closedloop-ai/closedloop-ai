import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import type { CostMetricWindow } from "@repo/lib/branches/branch-cost-slices";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_AT,
  createBranchArtifact,
  type TestDb,
} from "@/__tests__/support/branches/visible-branch.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { chunksOf } from "@/lib/chunks-of";
import {
  readBranchAnalyticsRollupAsOf,
  refreshBranchAnalyticsRollupBatch,
} from "./branch-analytics-rollup";
import { readCostMetricFacts } from "./branch-cost-window-metrics";

/**
 * ISS-12346 C1-C6: AI spend is the sum, over cost events dated in the window,
 * of each event's cost split evenly across the eligible branches its session
 * wrote to. The oracle below states that rule over plain arrays.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const SEED = 20_261_013;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const SEED_CONCURRENCY = 20;
const END = Date.parse("2026-09-30T00:00:00.000Z");
const WINDOWS: CostMetricWindow[] = [
  { key: "all", startAt: null, endAt: iso(END) },
  { key: "d30", startAt: iso(END - 30 * DAY), endAt: iso(END) },
  { key: "d7", startAt: iso(END - 7 * DAY), endAt: iso(END) },
  { key: "prior30", startAt: iso(END - 60 * DAY), endAt: iso(END - 30 * DAY) },
  // Edges that fall inside a UTC day, which no whole daily bucket can answer.
  {
    key: "midday",
    startAt: iso(END - 30 * DAY + 12 * HOUR),
    endAt: iso(END - 7 * DAY + 5 * HOUR),
  },
  {
    key: "sliver",
    startAt: iso(END - 3 * DAY + HOUR),
    endAt: iso(END - DAY / 2),
  },
];

type LinkKind =
  | "wrote"
  | "legacyNull"
  | "reviewed"
  | "legacyReviewed"
  | "prose";

type SeededEvent = {
  externalEventId: string;
  at: number;
  cost: number | null;
  tokens: number;
  negative?: "output" | "cacheRead" | "cacheWrite";
};

type SeededSession = {
  id: string;
  links: { branchIndex: number; kind: LinkKind }[];
  events: SeededEvent[];
};

function idsSql(ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`SELECT unnest(${[...ids]}::uuid[]) AS id`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function createRandom(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  return {
    chance: (probability: number) => next() < probability,
    int: (maximum: number) => Math.floor(next() * maximum),
    pick: <Value>(values: readonly Value[]): Value =>
      values[Math.floor(next() * values.length)] as Value,
  };
}

const COUNTS_IN_DIVISOR: Record<LinkKind, boolean> = {
  wrote: true,
  legacyNull: true,
  reviewed: false,
  legacyReviewed: false,
  prose: false,
};

describeIfDb("cost window metrics", () => {
  it("publishes the spend the per-event even split defines, window by window", async () => {
    const organizationId = await committedOrganizations.create();
    const random = createRandom(SEED);
    const dataset = await seed(organizationId, random);

    const { actual, expected, facts } = await compareToOracle(
      organizationId,
      dataset
    );

    expect(actual).toEqual(expected);
    // A fixture where a window sums nothing would make the equality vacuous.
    expect(expected.every((row) => row.spend > 0)).toBe(true);
    expect(facts.cohortHoldsEvents).toBe(true);
    // A dataset that holds unusable events is the point of this case.
    expect(facts.windows.get("all")?.unusable).toBeGreaterThan(5);
  });

  it("serves whole days from the daily rollup and edge days from events, with the same answer", async () => {
    const organizationId = await committedOrganizations.create();
    const dataset = await seed(organizationId, createRandom(SEED + 1), {
      clean: true,
    });
    await refreshBranchAnalyticsRollupBatch({
      organizationId,
      now: new Date(Date.now() + 5000),
    });
    const sessionIds = dataset.sessions.map((session) => session.id);
    const rollupRows = await withDb((db) =>
      db.branchAnalyticsSessionRollup.count({ where: { organizationId } })
    );
    // Control: the rollup is materialized and trusted, so this case does not
    // pass by quietly reading events.
    expect(rollupRows).toBeGreaterThan(20);
    await withDb(async (db) => {
      expect(
        await readBranchAnalyticsRollupAsOf(
          db,
          organizationId,
          sessionIds,
          new Date()
        )
      ).toBeInstanceOf(Date);
    });

    const { actual, expected } = await compareToOracle(organizationId, dataset);

    expect(actual).toEqual(expected);
    expect(expected.every((row) => row.spend > 0)).toBe(true);
  });

  it("reads events when a session holds a row the rollup refuses", async () => {
    const organizationId = await committedOrganizations.create();
    const dataset = await seed(organizationId, createRandom(SEED + 2), {
      clean: true,
    });
    await refreshBranchAnalyticsRollupBatch({
      organizationId,
      now: new Date(Date.now() + 5000),
    });
    // Newer than anything the session had when it was materialized, so the
    // rollup's own gate sees the session as behind its source.
    const lateAt = END - 6 * HOUR;
    const victim = dataset.sessions.find(
      (session) =>
        session.links.some(
          (link) => COUNTS_IN_DIVISOR[link.kind] && link.branchIndex < 5
        ) && session.events.every((event) => event.at < lateAt)
    );
    if (!victim) {
      throw new Error("Expected a session in the cohort");
    }
    victim.events.push({
      externalEventId: "late-negative",
      at: lateAt,
      cost: -4,
      tokens: 100,
    });
    await withDb((db) =>
      db.agentSessionTokenEvent.create({
        data: {
          agentSessionId: victim.id,
          externalEventId: "late-negative",
          model: "claude",
          estimatedCost: -4,
          eventCreatedAt: new Date(lateAt),
          createdAt: new Date(),
        },
        select: { id: true },
      })
    );

    const { actual, expected } = await compareToOracle(organizationId, dataset);

    expect(actual).toEqual(expected);
    expect(expected.every((row) => row.spend > 0)).toBe(true);
  });

  it("counts an unpriced event on an edge day and a priced one on a whole day through the rollup", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const start = END - 30 * DAY;
    const { branchIds } = await seedFixed(organizationId, user.id, [
      { kind: "wrote", at: start + 13 * HOUR, cost: 2 },
      { kind: "wrote", at: start + 14 * HOUR, cost: null },
      { kind: "wrote", at: start + 10 * DAY + 3 * HOUR, cost: 5 },
    ]);
    await refreshBranchAnalyticsRollupBatch({
      organizationId,
      now: new Date(Date.now() + 5000),
    });

    const facts = await readCostMetricFacts(
      organizationId,
      branchIds,
      idsSql(branchIds),
      WINDOWS
    );

    expect(facts.windows.get("midday")).toMatchObject({
      included: 2,
      unusable: 1,
    });
    expect(facts.windows.get("midday")?.spendUsd).toBeCloseTo(7, 6);
  });

  it("leaves out an event received after the rollup's own instant", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const start = END - 30 * DAY;
    const { branchIds } = await seedFixed(organizationId, user.id, [
      { kind: "wrote", at: start + 13 * HOUR, cost: 2 },
    ]);
    await refreshBranchAnalyticsRollupBatch({
      organizationId,
      now: new Date(Date.now() + 5000),
    });
    const sessionId = await withDb(async (db) => {
      const link = await db.artifactLink.findFirstOrThrow({
        where: { organizationId, targetId: branchIds[0] },
        select: { sourceId: true },
      });
      await db.agentSessionTokenEvent.create({
        data: {
          agentSessionId: link.sourceId,
          externalEventId: "after-instant",
          model: "claude",
          estimatedCost: 100,
          eventCreatedAt: new Date(start + 15 * HOUR),
          createdAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
      });
      return link.sourceId;
    });

    const facts = await readCostMetricFacts(
      organizationId,
      branchIds,
      idsSql(branchIds),
      WINDOWS
    );

    expect(sessionId).toBeTruthy();
    expect(facts.windows.get("midday")?.spendUsd).toBeCloseTo(2, 6);
    expect(facts.windows.get("midday")?.included).toBe(1);
  });

  it("counts an event past every old cap, so no session or event is dropped", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const branchId = await withDb((db) =>
      createBranchArtifact(db, organizationId, "wide", {
        firstPushedAt: ACTIVITY_AT,
      })
    );
    const sessionCount = 1200;
    const at = new Date(END - DAY);
    await withDb(async (db) => {
      const computeTarget = await db.computeTarget.create({
        data: {
          organizationId,
          userId: user.id,
          machineName: "m",
          platform: "darwin",
        },
        select: { id: true },
      });
      for (let start = 0; start < sessionCount; start += 200) {
        await seedSessionBatch(db, {
          organizationId,
          userId: user.id,
          computeTargetId: computeTarget.id,
          branchId,
          from: start,
          to: Math.min(start + 200, sessionCount),
          at,
        });
      }
    });

    const facts = await readCostMetricFacts(
      organizationId,
      [branchId],
      idsSql([branchId]),
      WINDOWS
    );

    // 1,200 sessions, 10 events each, $0.01 per event.
    expect(facts.windows.get("d7")?.included).toBe(12_000);
    expect(facts.windows.get("d7")?.spendUsd).toBeCloseTo(120, 6);
  });

  it("holds events for the cohort even when none fall in the window", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const { branchIds } = await seedFixed(organizationId, user.id, [
      { kind: "wrote", at: END - 200 * DAY, cost: 1 },
    ]);

    const facts = await readCostMetricFacts(
      organizationId,
      branchIds,
      idsSql(branchIds),
      WINDOWS
    );

    expect(facts.cohortHoldsEvents).toBe(true);
    expect(facts.windows.get("d30")).toMatchObject({
      spendUsd: 0,
      included: 0,
      unusable: 0,
    });
  });

  it("treats a cohort with no events as holding none, and only the cohort's links", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const { branchIds } = await seedFixed(organizationId, user.id, [
      { kind: "reviewed", at: END - DAY, cost: 5 },
      { kind: "legacyReviewed", at: END - DAY, cost: 5 },
    ]);

    const facts = await readCostMetricFacts(
      organizationId,
      branchIds,
      idsSql(branchIds),
      WINDOWS
    );

    expect(facts.cohortHoldsEvents).toBe(false);
    expect(facts.windows.get("all")?.spendUsd).toBe(0);
  });

  it("dates a cost by its event, with the window half-open", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const start = END - 7 * DAY;
    const { branchIds } = await seedFixed(organizationId, user.id, [
      { kind: "wrote", at: start, cost: 1 },
      { kind: "wrote", at: start - 1, cost: 10 },
      { kind: "wrote", at: END, cost: 100 },
      { kind: "wrote", at: END - 1, cost: 1000 },
    ]);

    const facts = await readCostMetricFacts(
      organizationId,
      branchIds,
      idsSql(branchIds),
      WINDOWS
    );

    expect(facts.windows.get("d7")?.spendUsd).toBeCloseTo(1001, 6);
    expect(facts.windows.get("d7")?.included).toBe(2);
  });

  it("puts an event on a shared window edge in the later window only", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const edge = END - 30 * DAY;
    const { branchIds } = await seedFixed(organizationId, user.id, [
      { kind: "wrote", at: edge, cost: 3 },
    ]);

    const facts = await readCostMetricFacts(
      organizationId,
      branchIds,
      idsSql(branchIds),
      WINDOWS
    );

    expect(facts.windows.get("d30")?.included).toBe(1);
    expect(facts.windows.get("prior30")?.included).toBe(0);
  });

  it("counts the cohort in the divisor even when the eligible list omits it", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const { cohortId, otherId } = await withDb(async (db) => {
      const first = await createBranchArtifact(
        db,
        organizationId,
        "in-cohort",
        {
          firstPushedAt: ACTIVITY_AT,
        }
      );
      const second = await createBranchArtifact(db, organizationId, "other", {
        firstPushedAt: ACTIVITY_AT,
      });
      const computeTarget = await db.computeTarget.create({
        data: {
          organizationId,
          userId: user.id,
          machineName: "m",
          platform: "darwin",
        },
        select: { id: true },
      });
      await seedSession(db, {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
        ordinal: 0,
        links: [
          { kind: "wrote", branchId: first },
          { kind: "wrote", branchId: second },
        ],
        events: [
          { externalEventId: "shared", at: END - DAY, cost: 4, tokens: 1 },
        ],
      });
      return { cohortId: first, otherId: second };
    });

    const facts = await readCostMetricFacts(
      organizationId,
      [cohortId],
      idsSql([otherId]),
      WINDOWS
    );

    expect(facts.windows.get("d7")?.spendUsd).toBeCloseTo(2, 6);
  });

  it("makes an unpriced or negative-cost event unusable, and counts a priced one whatever its token counts (ISS-12346 C1)", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const at = END - DAY;
    const { branchIds } = await seedFixed(organizationId, user.id, [
      { kind: "wrote", at, cost: 2 },
      { kind: "wrote", at, cost: null },
      { kind: "wrote", at, cost: -3 },
      { kind: "wrote", at, cost: 5, tokens: -1 },
      { kind: "wrote", at, cost: 6, negative: "output" },
      { kind: "wrote", at, cost: 7, negative: "cacheRead" },
      { kind: "wrote", at, cost: 8, negative: "cacheWrite" },
    ]);

    const facts = await readCostMetricFacts(
      organizationId,
      branchIds,
      idsSql(branchIds),
      WINDOWS
    );

    expect(facts.windows.get("d7")).toMatchObject({ included: 5, unusable: 2 });
    expect(facts.windows.get("d7")?.spendUsd).toBeCloseTo(28, 6);
  });
});

const COHORT_INDEXES = [0, 1, 2, 3, 4];
const ELIGIBLE_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

type Dataset = Awaited<ReturnType<typeof seed>>;

function readFactsFor(organizationId: string, dataset: Dataset) {
  return readCostMetricFacts(
    organizationId,
    COHORT_INDEXES.map((index) => dataset.branchIds[index] as string),
    idsSql(ELIGIBLE_INDEXES.map((index) => dataset.branchIds[index] as string)),
    WINDOWS
  );
}

type WindowSummary = {
  key: string;
  spend: number;
  included: number;
  unusable: number;
};

/** What the SQL read and the plain-array oracle each say, window by window. */
async function compareToOracle(organizationId: string, dataset: Dataset) {
  const facts = await readFactsFor(organizationId, dataset);
  const actual: WindowSummary[] = [];
  const expected: WindowSummary[] = [];
  for (const window of WINDOWS) {
    const answer = facts.windows.get(window.key);
    actual.push({
      key: window.key,
      spend: Number((answer?.spendUsd ?? Number.NaN).toFixed(6)),
      included: answer?.included ?? Number.NaN,
      unusable: answer?.unusable ?? Number.NaN,
    });
    const wanted = oracle(
      dataset.sessions,
      COHORT_INDEXES,
      ELIGIBLE_INDEXES,
      window
    );
    expected.push({
      key: window.key,
      spend: Number(wanted.spendUsd.toFixed(6)),
      included: wanted.included,
      unusable: wanted.unusable,
    });
  }
  return { actual, expected, facts };
}

function oracle(
  sessions: readonly SeededSession[],
  cohort: readonly number[],
  eligible: readonly number[],
  window: CostMetricWindow
) {
  const startMs =
    window.startAt === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(window.startAt);
  const endMs = Date.parse(window.endAt);
  const divisorSet = new Set([...eligible, ...cohort]);
  let spendUsd = 0;
  let included = 0;
  let unusable = 0;
  for (const session of sessions) {
    const counted = new Set(
      session.links
        .filter(
          (link) =>
            COUNTS_IN_DIVISOR[link.kind] && divisorSet.has(link.branchIndex)
        )
        .map((link) => link.branchIndex)
    );
    const inCohort = [...counted].filter((index) =>
      cohort.includes(index)
    ).length;
    if (inCohort === 0) {
      continue;
    }
    for (const event of session.events) {
      if (!(event.at >= startMs && event.at < endMs)) {
        continue;
      }
      const usable = event.cost !== null && event.cost >= 0;
      if (usable) {
        spendUsd += ((event.cost as number) * inCohort) / counted.size;
        included += 1;
      } else {
        unusable += 1;
      }
    }
  }
  return { spendUsd, included, unusable };
}

async function seed(
  organizationId: string,
  random: ReturnType<typeof createRandom>,
  options: { clean?: boolean } = {}
) {
  const user = await createTestUser(organizationId);
  return withDb(async (db) => {
    const branchIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      branchIds.push(
        await createBranchArtifact(db, organizationId, `cost-${index}`, {
          firstPushedAt: ACTIVITY_AT,
        })
      );
    }
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: "m",
        platform: "darwin",
      },
      select: { id: true },
    });
    const sessions: SeededSession[] = [];
    for (let index = 0; index < 60; index += 1) {
      const linkCount = 1 + random.int(4);
      const branchIndexes = new Set<number>();
      while (branchIndexes.size < linkCount) {
        branchIndexes.add(random.int(12));
      }
      const links = [...branchIndexes].map((branchIndex) => ({
        branchIndex,
        kind: random.pick<LinkKind>([
          "wrote",
          "wrote",
          "wrote",
          "legacyNull",
          "reviewed",
          "legacyReviewed",
          "prose",
        ]),
      }));
      const events: SeededEvent[] = [];
      const eventCount = random.int(14);
      for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
        events.push({
          externalEventId: `e-${index}-${eventIndex}`,
          at: END - Math.floor(random.int(100 * DAY * 1.05) - 2 * DAY),
          cost: randomCost(random, options.clean),
          tokens: !options.clean && random.chance(0.03) ? -1 : 100,
        });
      }
      const id = await seedSession(db, {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
        ordinal: index,
        links: links.map((link) => ({
          ...link,
          branchId: branchIds[link.branchIndex] as string,
        })),
        events,
      });
      sessions.push({ id, links, events });
    }
    return { branchIds, sessions };
  });
}

function randomCost(
  random: ReturnType<typeof createRandom>,
  clean = false
): number | null {
  if (random.chance(0.08)) {
    return null;
  }
  if (!clean && random.chance(0.04)) {
    return -1;
  }
  return random.int(500_000) / 100_000;
}

function seedFixed(
  organizationId: string,
  userId: string,
  specs: {
    kind: LinkKind;
    at: number;
    cost: number | null;
    externalEventId?: string;
    tokens?: number;
    negative?: SeededEvent["negative"];
  }[]
) {
  return withDb(async (db) => {
    const branchId = await createBranchArtifact(db, organizationId, "fixed", {
      firstPushedAt: ACTIVITY_AT,
    });
    const computeTarget = await db.computeTarget.create({
      data: { organizationId, userId, machineName: "m", platform: "darwin" },
      select: { id: true },
    });
    let ordinal = 0;
    for (const spec of specs) {
      await seedSession(db, {
        organizationId,
        userId,
        computeTargetId: computeTarget.id,
        ordinal,
        links: [{ kind: spec.kind, branchId }],
        events: [
          {
            externalEventId: spec.externalEventId ?? `fixed-${ordinal}`,
            at: spec.at,
            cost: spec.cost,
            tokens: spec.tokens ?? 100,
            negative: spec.negative,
          },
        ],
      });
      ordinal += 1;
    }
    return { branchIds: [branchId] };
  });
}

async function seedSession(
  db: TestDb,
  input: {
    organizationId: string;
    userId: string;
    computeTargetId: string;
    ordinal: number;
    links: { kind: LinkKind; branchId: string }[];
    events: SeededEvent[];
  }
): Promise<string> {
  const session = await db.artifact.create({
    data: {
      organizationId: input.organizationId,
      type: ArtifactType.SESSION,
      name: `cost-session-${input.ordinal}`,
      status: "active",
    },
    select: { id: true },
  });
  await db.sessionDetail.create({
    data: {
      artifactId: session.id,
      computeTargetId: input.computeTargetId,
      externalSessionId: `cost-ext-${session.id}`,
      harness: "claude",
      sessionStartedAt: ACTIVITY_AT,
      sessionUpdatedAt: ACTIVITY_AT,
      lastActivityAt: ACTIVITY_AT,
    },
    select: { artifactId: true },
  });
  for (const link of input.links) {
    await db.artifactLink.create({
      data: {
        organizationId: input.organizationId,
        sourceId: session.id,
        targetId: link.branchId,
        linkType: LinkType.RelatesTo,
        ...linkParticipation(link.kind),
      },
      select: { id: true },
    });
  }
  await db.agentSessionTokenEvent.createMany({
    data: input.events.map((event) => ({
      agentSessionId: session.id,
      externalEventId: event.externalEventId,
      model: "claude",
      inputTokens: BigInt(event.tokens),
      outputTokens: BigInt(event.negative === "output" ? -1 : 0),
      cacheReadTokens: BigInt(event.negative === "cacheRead" ? -1 : 0),
      cacheWriteTokens: BigInt(event.negative === "cacheWrite" ? -1 : 0),
      estimatedCost: event.cost,
      eventCreatedAt: new Date(event.at),
    })),
  });
  return session.id;
}

function linkParticipation(kind: LinkKind) {
  const base = { linkKind: SessionArtifactLinkKind.SessionBranch };
  switch (kind) {
    case "wrote":
      return {
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: base,
      };
    case "reviewed":
      return {
        branchParticipation: BranchParticipationKind.Reviewed,
        metadata: base,
      };
    case "legacyNull":
      return { branchParticipation: null, metadata: base };
    case "prose":
      return {
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: { linkKind: SessionArtifactLinkKind.SessionPrProse },
      };
    case "legacyReviewed":
      return {
        branchParticipation: null,
        metadata: { ...base, relationTypes: [SessionPrRelationType.Reviewed] },
      };
    default:
      throw new Error("unhandled link kind");
  }
}

async function seedSessionBatch(
  db: TestDb,
  input: {
    organizationId: string;
    userId: string;
    computeTargetId: string;
    branchId: string;
    from: number;
    to: number;
    at: Date;
  }
): Promise<void> {
  const ordinals = Array.from(
    { length: input.to - input.from },
    (_, index) => input.from + index
  );
  for (const group of chunksOf(ordinals, SEED_CONCURRENCY)) {
    await Promise.all(
      group.map((ordinal) =>
        seedSession(db, {
          organizationId: input.organizationId,
          userId: input.userId,
          computeTargetId: input.computeTargetId,
          ordinal,
          links: [{ kind: "wrote", branchId: input.branchId }],
          events: Array.from({ length: 10 }, (_, eventIndex) => ({
            externalEventId: `wide-${ordinal}-${eventIndex}`,
            at: input.at.getTime(),
            cost: 0.01,
            tokens: 10,
          })),
        })
      )
    );
  }
}
