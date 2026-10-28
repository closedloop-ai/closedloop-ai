/**
 * ISS-10467 — the per-CONTENT-VERSION drill-down inside the family-scoped
 * agent-component detail.
 *
 * ISS-10341 made every aggregate on that page family-scoped and thereby removed
 * the only way to see one revision's own usage. This suite pins the drill-down
 * that restores it, and specifically the three things a per-version view on THIS
 * data is easy to get wrong:
 *
 *  1. The scope is real. A narrowing read must actually narrow — a double that
 *     ignored the emitted predicate would return the family to a broken
 *     implementation and let it pass. So the doubles EVALUATE
 *     `usageContentScopeWhere`'s two arms against one declared row set, the same
 *     way the ISS-10341 sibling suite does.
 *  2. A MEASURED ZERO and a NOT-COMPUTED value are different answers. The
 *     ISS-5363 contract exists for that distinction and a drill-down that
 *     collapses them is the ISS-10341 defect one layer out, so `0` and `null`
 *     are pinned in separate cases that would each fail if the two merged.
 *  3. The version-less population is COUNTED. 32 of `frankenstein`'s 36 rows
 *     name no version at all, so the corpus here carries version-less rows and
 *     the partition over them is asserted — silently dropping them is exactly
 *     what ISS-10341 fixed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
  listByArtifactIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  buildInventoryRow,
  buildServiceDb,
} from "@/__tests__/support/agent-components/service-db-double";
import { loadVersionUsageForOrg } from "../service/detail-version-usage";

const ORG = "org-iss-10467";
const KIND = "skill";
const KEY = "frankenstein";
const INVENTORY_ID = "ac-frankenstein";
/** The revision the family's list row links at — its canonical version. */
const REV_A = "a".repeat(64);
/** A second revision of the same family. */
const REV_B = "b".repeat(64);
/** A revision the org holds that nothing ever ran. */
const REV_UNUSED = "c".repeat(64);
/** A hash no revision row carries — an unknown revision, not an unused one. */
const REV_UNKNOWN = "f".repeat(64);
const SLUG = `${KIND}::${REV_A}`;

/** Each revision's captured body — what the usage-space digest is derived from. */
const BODY_BY_HASH: Readonly<Record<string, string>> = {
  [REV_A]: "Body of revision A.",
  [REV_B]: "Body of revision B.",
  [REV_UNUSED]: "Body of the revision nothing ran.",
};

/**
 * The digest a usage row is ACTUALLY stamped with for a revision's body.
 *
 * DELIBERATELY NOT THE REVISION'S OWN `contentHash`, which is the whole point of
 * this fixture: `AgentComponentVersion.contentHash` is a raw `sha256Hex`, while
 * `AgentComponentSessionUsage.componentVersionHash` carries the domain-tagged,
 * kind-scoped `computeDefinitionHash` digest the collector stamps at invocation,
 * and the two never agree for the same file. Seeding the SAME string in both
 * columns — which this fixture used to do — passes against either scoping and so
 * says nothing about the translation the read exists to perform; on real data
 * that scoping matched no row and every revision reported a measured-looking
 * zero (tamsinb review). Computed straight from `computeDefinitionHash` rather
 * than through the production helper, so a regression there cannot move both
 * sides of the comparison at once.
 */
function usageDigestFor(hash: string): string {
  return computeDefinitionHash({
    body: BODY_BY_HASH[hash] ?? "",
    frontmatter: "",
    kind: KIND,
  }).definitionHash;
}

type UsageFixture = {
  agentSessionId: string;
  invocationCount: number;
  /** The coarse hash-at-invocation. `null` ⇒ the row names no version. */
  componentVersionHash: string | null;
  /** The F1 link. `null` ⇒ the row names no version by that route either. */
  definitionVersionId: string | null;
};

function usageRow(overrides: Partial<UsageFixture> = {}): UsageFixture {
  return {
    agentSessionId: "sess-1",
    invocationCount: 1,
    componentVersionHash: null,
    definitionVersionId: null,
    ...overrides,
  };
}

/**
 * The declared population, shaped like the real one: MOSTLY version-less, with
 * two revisions genuinely named and a third revision that exists in the history
 * and was never run.
 */
const FAMILY_USAGE: readonly UsageFixture[] = [
  usageRow({ agentSessionId: "sess-1", invocationCount: 40 }),
  usageRow({ agentSessionId: "sess-2", invocationCount: 29 }),
  usageRow({
    agentSessionId: "sess-3",
    invocationCount: 4,
    componentVersionHash: usageDigestFor(REV_A),
  }),
  usageRow({
    agentSessionId: "sess-5",
    invocationCount: 2,
    componentVersionHash: usageDigestFor(REV_A),
  }),
  usageRow({
    agentSessionId: "sess-4",
    invocationCount: 1,
    componentVersionHash: usageDigestFor(REV_B),
  }),
];
const UNVERSIONED_INVOCATIONS = 69;
const UNVERSIONED_SESSIONS = 2;
const VERSIONED_INVOCATIONS = 7;
const VERSIONED_SESSIONS = 3;
const REV_A_INVOCATIONS = 6;
const REV_A_SESSIONS = 2;

/** `usageContentScopeWhere`'s two arms, evaluated honestly. */
function passesContentScope(
  where: Record<string, unknown>,
  row: UsageFixture
): boolean {
  const arms = where.OR as
    | {
        componentVersionHash?: { in?: string[] };
        definitionVersion?: unknown;
      }[]
    | undefined;
  if (!arms) {
    return true;
  }
  return arms.some((arm) => {
    if (arm.componentVersionHash?.in) {
      return (
        row.componentVersionHash !== null &&
        arm.componentVersionHash.in.includes(row.componentVersionHash)
      );
    }
    if (arm.definitionVersion) {
      return row.definitionVersionId !== null;
    }
    return false;
  });
}

function usageGroupBy(rows: readonly UsageFixture[]) {
  return vi.fn((args: { where?: Record<string, unknown> }) => {
    const where = args.where ?? {};
    const fkIds = (where.agentComponentId as { in?: string[] } | undefined)?.in;
    const admitted = rows.filter(
      (row) =>
        (!fkIds || fkIds.includes(INVENTORY_ID)) &&
        passesContentScope(where, row)
    );
    return Promise.resolve(
      admitted.map((row) => ({
        agentComponentId: INVENTORY_ID,
        agentSessionId: row.agentSessionId,
        gitBranch: "",
        harness: null,
        componentKind: KIND,
        componentKey: KEY,
        componentVersionHash: row.componentVersionHash,
        definitionVersionId: row.definitionVersionId,
        _sum: { invocationCount: row.invocationCount, errorCount: 0 },
        _max: { lastInvokedAt: null },
      }))
    );
  });
}

/** Every `where` the usage `groupBy` was issued with. */
function groupByWheres(db: Record<string, unknown>): Record<string, unknown>[] {
  const delegate = db.agentComponentSessionUsage as {
    groupBy: { mock: { calls: [{ where?: Record<string, unknown> }][] } };
  };
  return delegate.groupBy.mock.calls.map(([args]) => args.where ?? {});
}

function installDb(
  rows: readonly UsageFixture[] = FAMILY_USAGE,
  versionHashes: readonly string[] = [REV_A, REV_B, REV_UNUSED],
  storedRedacted: Readonly<Record<string, StoredRedactedRevision>> = {}
) {
  const db = buildServiceDb({
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([
        buildInventoryRow({
          id: INVENTORY_ID,
          organizationId: ORG,
          componentKind: KIND,
          componentKey: KEY,
          name: KEY,
          contentHash: REV_A,
        }),
      ]),
    },
    agentComponentVersion: {
      findMany: vi.fn((args: { where?: Record<string, unknown> }) => {
        // The EXACT (`definitionVersion.definitionHash`) resolution finds
        // nothing, so the route resolves through the coarse `contentHash`
        // fallback — the shape `resolveContentHashIdentity` documents, and the
        // shape `frankenstein` is actually in.
        if (args.where?.definitionVersion) {
          return Promise.resolve([]);
        }
        // The identity read asks for `contentHash` alone; the drill-down's own
        // read additionally joins the definition link.
        return Promise.resolve(
          versionHashes.map((contentHash) => ({
            componentKey: KEY,
            content:
              storedRedacted[contentHash]?.content ??
              BODY_BY_HASH[contentHash] ??
              "",
            usageScopeHash: storedRedacted[contentHash]?.usageScopeHash ?? null,
            contentHash,
            definitionVersion: null,
          }))
        );
      }),
    },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: usageGroupBy(rows),
    },
  });
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  return db;
}

/**
 * ISS-10467 (operator ruling 2026-09-26): the `SessionDetail` rows the per-version
 * token/cost fold reads.
 *
 * The four token columns are `BigInt NOT NULL DEFAULT 0` and `estimatedCost` is a
 * nullable `Decimal`, so these fixtures reproduce the ONE asymmetry the fold
 * turns on: a row can be present and unpriced, and that is different from having
 * no row at all.
 */
function sessionDetailRows(
  rows: readonly {
    artifactId: string;
    tokens: number;
    estimatedCost: number | null;
  }[]
) {
  return {
    // TWO READS ENTER THIS DELEGATE and only one is under test: the LOC/cost
    // enrichment read, and the cohort walk that folds merged-PR outcomes off
    // `artifact.sourceLinks`. Discriminating on the cohort's own `artifact`
    // selection keeps the walk seeing the empty cohort every other case in this
    // file gives it, so a spend assertion here cannot be answered — or broken —
    // by a half-shaped cohort row.
    findMany: vi.fn((args: { select?: Record<string, unknown> }) => {
      if (args.select?.artifact) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        rows.map((row) => ({
          artifactId: row.artifactId,
          linesAdded: 0,
          linesRemoved: 0,
          estimatedCost: row.estimatedCost,
          // Split across the four counters so the assertions below can only pass
          // if every term reaches the shared sum — a fold that dropped cache
          // reads would report 300 where the row carries 1,000.
          inputTokens: BigInt(row.tokens - 700),
          outputTokens: BigInt(200),
          cacheReadTokens: BigInt(400),
          cacheWriteTokens: BigInt(100),
          locSource: "git",
          repositoryFullName: null,
        }))
      );
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listByArtifactIds.mockResolvedValue([]);
});

describe("agent-component version-usage drill-down (ISS-10467)", () => {
  it("reports one revision's own usage, not the family's", async () => {
    installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].hash).toBe(REV_A);
    expect(result?.entries[0].invocations).toBe(REV_A_INVOCATIONS);
    expect(result?.entries[0].sessions).toBe(REV_A_SESSIONS);
  });

  it("narrows through the EMITTED content scope, and never exceeds its family", async () => {
    const db = installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    const familyInvocations = UNVERSIONED_INVOCATIONS + VERSIONED_INVOCATIONS;
    expect(result?.entries[0].invocations).toBeLessThan(familyInvocations);
    // The narrowing is the predicate the read ISSUED, not a post-filter: at
    // least one usage read carried a content scope naming exactly this
    // revision. A mock that answered the same rows regardless of its `where`
    // would prove nothing about the filter this ticket exists to add.
    // The predicate must name the USAGE-SPACE digest, not merely the revision's
    // coarse hash: a scope carrying only the latter matches no production row.
    const scoped = groupByWheres(db).filter((where) =>
      JSON.stringify(where).includes(usageDigestFor(REV_A))
    );
    expect(scoped.length).toBeGreaterThan(0);
  });

  it("counts the version-less population instead of dropping it", async () => {
    installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.attribution.unversioned.invocations).toBe(
      UNVERSIONED_INVOCATIONS
    );
    expect(result?.attribution.unversioned.sessions).toBe(UNVERSIONED_SESSIONS);
    expect(result?.attribution.versioned.invocations).toBe(
      VERSIONED_INVOCATIONS
    );
    expect(result?.attribution.versioned.sessions).toBe(VERSIONED_SESSIONS);
  });

  // ISS-4965 (Perrin, 2026-10-05): a revision stored secret-redacted keeps the
  // usage digest of the text as written, which is what its usage rows carry.
  it("reports a redacted revision's real usage through its stored usage digest", async () => {
    installDb(FAMILY_USAGE, [REV_A, REV_B, REV_UNUSED], {
      [REV_A]: {
        content: "Body of [REDACTED:ghp] revision A.",
        usageScopeHash: usageDigestFor(REV_A),
      },
    });

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.entries[0].invocations).toBe(REV_A_INVOCATIONS);
    expect(result?.entries[0].sessions).toBe(REV_A_SESSIONS);
  });

  it("emits a MEASURED ZERO for a revision the org holds and nothing ran", async () => {
    installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_UNUSED]);

    // Zero, not null: every lane issued its read and this revision genuinely
    // ran nothing.
    expect(result?.entries[0].invocations).toBe(0);
    expect(result?.entries[0].sessions).toBe(0);
  });

  it("emits NOT-COMPUTED for a revision the family's history does not carry", async () => {
    installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_UNKNOWN]);

    // Null, not zero: there is no population here to have measured, so
    // asserting `0` would be a measurement nobody took. This case and the one
    // above would both pass if the two states were collapsed, and exactly one
    // of them would fail whichever way they were collapsed.
    expect(result?.entries[0].invocations).toBeNull();
    expect(result?.entries[0].sessions).toBeNull();
  });

  it("answers for every requested revision, in the order requested", async () => {
    installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_B, REV_A]);

    expect(result?.entries.map((entry) => entry.hash)).toEqual([REV_B, REV_A]);
    expect(result?.entries[0].invocations).toBe(1);
    expect(result?.entries[1].invocations).toBe(REV_A_INVOCATIONS);
  });

  it("404s a slug this org has no live component for", async () => {
    const db = buildServiceDb({
      agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
      agentComponentVersion: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ componentKey: KEY, contentHash: REV_A }]),
      },
      agentComponentSessionUsage: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
    });
    mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
    mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) =>
      cb(db)
    );

    expect(await loadVersionUsageForOrg(ORG, SLUG, [REV_A])).toBeNull();
  });

  it("folds the revision's OWN token and cost totals, not the family's", async () => {
    // ISS-10467, operator ruling (marisolashgrove, 2026-09-26): "I think we actually
    // want to break down token/cost by version for skills & commands, in
    // particularly skills." The producer already read every session's priced cost
    // for the LOC/$ ratio and the panel dropped both aggregates; this is the fold
    // that publishes them.
    //
    // REV_A ran in sess-3 and sess-5 only. sess-1/sess-2 are the version-less
    // rows and sess-4 belongs to REV_B, and all three are seeded with LARGE
    // figures: a fold scoped to the family rather than to the revision reports
    // 5,000 / $50 here instead of 2,000 / $12.
    const db = installDb();
    db.sessionDetail = sessionDetailRows([
      { artifactId: "sess-3", tokens: 1200, estimatedCost: 7 },
      { artifactId: "sess-5", tokens: 800, estimatedCost: 5 },
      { artifactId: "sess-1", tokens: 1000, estimatedCost: 13 },
      { artifactId: "sess-2", tokens: 1000, estimatedCost: 12 },
      { artifactId: "sess-4", tokens: 1000, estimatedCost: 13 },
    ]) as never;

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.entries[0].totalTokens).toBe(2000);
    expect(result?.entries[0].estimatedCostUsd).toBe(12);
    // Both sessions reported both terms, so neither figure is a floor.
    expect(result?.entries[0].totalTokensPartial).toBe(false);
    expect(result?.entries[0].estimatedCostPartial).toBe(false);
    // The revision's counts are unchanged by the addition — this is an added
    // readout, not a re-scoping of the ones that shipped.
    expect(result?.entries[0].invocations).toBe(REV_A_INVOCATIONS);
    expect(result?.entries[0].sessions).toBe(REV_A_SESSIONS);
  });

  it("marks the cost a FLOOR when one of the revision's sessions was never priced", async () => {
    // `SessionDetail.estimatedCost` is nullable with no default (ISS-8515), and
    // the ingest now writes null rather than fabricating $0 for a session it
    // cannot price. The $7 it CAN account for is published — discarding a real
    // partial sum is the failure root AGENTS.md names — but it is published as a
    // floor, because bare it would claim the revision cost $7 in total.
    const db = installDb();
    db.sessionDetail = sessionDetailRows([
      { artifactId: "sess-3", tokens: 1200, estimatedCost: 7 },
      { artifactId: "sess-5", tokens: 800, estimatedCost: null },
    ]) as never;

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.entries[0].estimatedCostUsd).toBe(7);
    expect(result?.entries[0].estimatedCostPartial).toBe(true);
    // ONE ABSENT OPERAND MUST NOT TAKE THE OTHER WITH IT: both rows carried token
    // counters, so that sum is complete and must NOT wear a floor marker.
    expect(result?.entries[0].totalTokens).toBe(2000);
    expect(result?.entries[0].totalTokensPartial).toBe(false);
  });

  it("publishes NOTHING MEASURED rather than a $0 the enrichment read never made", async () => {
    // `loadSessionLocCost` FAILS OPEN with an empty map, so a failed or empty
    // enrichment read is indistinguishable from "no rows" here — and a fold that
    // summed only the entries it found would publish a confident `0` for a
    // revision with real, unread sessions. The default double returns no
    // sessionDetail rows, which is exactly that state.
    installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.entries[0].totalTokens).toBeNull();
    expect(result?.entries[0].estimatedCostUsd).toBeNull();
    // Nothing was measured, so nothing is a floor either — a marker here would
    // describe a bound on a figure that does not exist.
    expect(result?.entries[0].totalTokensPartial).toBe(false);
    expect(result?.entries[0].estimatedCostPartial).toBe(false);
    // And the counts beside them ARE measured, so this case cannot pass on a
    // read that failed outright.
    expect(result?.entries[0].invocations).toBe(REV_A_INVOCATIONS);
  });

  it("keeps a MEASURED $0 as a measurement, not as the unmeasured dash", async () => {
    // The null-versus-zero rule `locPerDollarCostMeasured` owns: a session that
    // was priced and cost nothing is a real figure, and collapsing it into the
    // "not computed" null would tell the reader we could not price work we know
    // was free.
    const db = installDb();
    db.sessionDetail = sessionDetailRows([
      { artifactId: "sess-3", tokens: 700, estimatedCost: 0 },
      { artifactId: "sess-5", tokens: 700, estimatedCost: 0 },
    ]) as never;

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.entries[0].estimatedCostUsd).toBe(0);
    expect(result?.entries[0].estimatedCostPartial).toBe(false);
  });

  it("treats a row whose token columns were not read as a hole, never as NaN", async () => {
    // REGRESSION, caught by CI on this branch: the first cut coerced the columns
    // with a bare `Number(row.inputTokens)`, so a row selected without them put
    // `NaN` on a `number` field — a bad value persisted into a record, and
    // `NaN + 800` renders as `NaN` on the panel. A term nobody read is a term
    // nobody measured, so the row is a COVERAGE HOLE and the sibling session's
    // real total is published as a floor.
    const db = installDb();
    db.sessionDetail = {
      findMany: vi.fn((args: { select?: Record<string, unknown> }) => {
        if (args.select?.artifact) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          {
            artifactId: "sess-3",
            linesAdded: 0,
            linesRemoved: 0,
            estimatedCost: 7,
            inputTokens: BigInt(500),
            outputTokens: BigInt(200),
            cacheReadTokens: BigInt(200),
            cacheWriteTokens: BigInt(100),
            locSource: "git",
            repositoryFullName: null,
          },
          // The columns absent entirely — what a narrowed select hands back.
          {
            artifactId: "sess-5",
            linesAdded: 0,
            linesRemoved: 0,
            estimatedCost: 5,
            locSource: "git",
            repositoryFullName: null,
          },
        ]);
      }),
    } as never;

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_A]);

    expect(result?.entries[0].totalTokens).toBe(1000);
    expect(Number.isNaN(result?.entries[0].totalTokens)).toBe(false);
    expect(result?.entries[0].totalTokensPartial).toBe(true);
    // Both sessions were PRICED, so the cost is complete and exact — the token
    // hole must not spill onto it.
    expect(result?.entries[0].estimatedCostUsd).toBe(12);
    expect(result?.entries[0].estimatedCostPartial).toBe(false);
  });

  it("answers a revision nothing ran with the measured zeroes its counts report", async () => {
    // REV_UNUSED exists in the history and has no usage rows, so its session set
    // is empty: there is nothing to have measured a cost over, and `null` is the
    // honest answer rather than `$0.00`. Its COUNTS stay measured zeroes, which is
    // the ISS-5363 common case — the two states coexist in one entry.
    installDb();

    const result = await loadVersionUsageForOrg(ORG, SLUG, [REV_UNUSED]);

    expect(result?.entries[0].invocations).toBe(0);
    expect(result?.entries[0].totalTokens).toBeNull();
    expect(result?.entries[0].estimatedCostUsd).toBeNull();
  });
});

/** ISS-4965: the stored columns of a revision whose body was secret-redacted. */
type StoredRedactedRevision = { content: string; usageScopeHash: string };
