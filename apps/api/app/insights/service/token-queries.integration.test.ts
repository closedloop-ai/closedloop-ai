import { InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { analyzeOnSeedingConnection } from "@/__tests__/utils/fixture-db";
import {
  type InsightsScopeContext,
  sessionScopeSql,
} from "@/app/insights/service/scope";
import { fetchModelUsageRows } from "@/app/insights/service/token-queries";

/**
 * ISS-8052 — `fetchModelUsageRows` emits its (day, model) groups in a DEFINED
 * order, proved against a real Postgres.
 *
 * `stackModelSeries` inserts these rows into a plain object in ARRIVAL order and
 * `JSON.stringify` preserves insertion order, so the row order is part of the
 * response bytes and is byte-compared by the Layer 5.3 golden fixture. Left to an
 * unordered `GROUP BY`, Postgres emits whatever order the chosen plan produces:
 * same data, same numbers, different serialization.
 *
 * WHY THE SEED PINS THE PLANNER (ISS-8195). Every case below can only fail on a
 * missing `ORDER BY` while this database emits grouped rows out of order. When
 * the planner reaches for a Sort + GroupAggregate instead, an unordered query
 * returns ascending rows BY ACCIDENT and the whole file goes green against the
 * bug. Which plan it picks is not a property of this seed — measured on
 * PostgreSQL 16, same seed, same `ANALYZE`, varying only what else is in the
 * database:
 *
 *   freshly migrated DB    → HashAggregate   → out of order → file can fail
 *   DB carrying other rows → Sort + GroupAgg → ascending    → file CANNOT fail
 *
 * That second row is CI. `pnpm --filter=api test:integration` runs its files
 * SERIALLY against ONE database (`--no-file-parallelism`), so by the time this
 * file runs, the tables carry everything the preceding files put there, the org
 * predicate turns selective, the planner switches to index scans over a handful
 * of estimated rows, and a Sort + GroupAggregate becomes the cheap plan. A
 * developer running this one file against a clean database gets the first row
 * and sees a suite that discriminates. ISS-8052 read the flip as being about
 * `ANALYZE`; it is about POPULATION, and `ANALYZE` only looked load-bearing
 * because it was the one knob varied on an otherwise empty database.
 *
 * So the aggregate strategy is pinned rather than hoped for: `seedCorpus`
 * disables the sort paths for the duration of the (rolled-back) transaction,
 * which prices every accidentally-ordered plan out of contention and leaves
 * HashAggregate. An explicit `ORDER BY` is a semantic requirement rather than a
 * costed choice, so production still sorts — which is exactly the asymmetry
 * these cases need in order to tell the two apart. Measured across all four
 * combinations of {empty, populated} × {ANALYZE, no ANALYZE}, the precondition
 * now holds in every one.
 *
 * TWO GUARDS, DELIBERATELY. `token-queries.test.ts` (ISS-8149) captures the
 * generated SQL and asserts the `ORDER BY day, tu.model` clause is emitted at
 * all — a plan-independent check that reddens the moment the clause is deleted,
 * and the one that runs in the `test-shard` lane behind the required `test`
 * context. This file proves the
 * stronger, behavioural half: that a real Postgres actually hands the rows back
 * in that order. The SQL-shape guard alone cannot see a clause that is present
 * but wrong; these cases alone could not fail until the planner was pinned. The
 * earlier objection to asserting an unordered `GROUP BY` here — that Postgres
 * may pick a sorted or a hashed aggregate for the same seed — is what
 * `pinHashAggregate()` removes, by pricing the sorted plans out of contention
 * rather than hoping for the hashed one.
 *
 * NOT COVERED, deliberately: a null/unavailable `session_started_at`. The column
 * is non-nullable on `SessionDetail`, so no such row can be seeded — the
 * date-window rule's null case is unrepresentable here rather than untested.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
/**
 * One session per distinct calendar day, all inside the window, listed out of
 * order so the day axis is not sorted by construction either. Midday UTC, so a
 * Chicago shift keeps each session on the same calendar day.
 */
const SESSION_DAYS = [
  new Date("2026-06-03T12:00:00.000Z"),
  new Date("2026-06-01T12:00:00.000Z"),
  new Date("2026-06-02T12:00:00.000Z"),
];
const OUT_OF_WINDOW = new Date("2026-01-15T12:00:00.000Z");

/**
 * Seeded in this order — descending — so the physical row order is the reverse
 * of the contract. The names share vendor prefixes, as the real corpus does,
 * because a shared prefix is what makes a lexicographic comparison discriminate.
 */
const MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-opus-4-6",
  "claude-haiku-4-5",
  "claude-fable-5",
  "amazon-nova-2",
];

/**
 * The order the query must emit within each day, sorted HERE rather than read
 * back from the query, so the expectation does not derive from the thing it
 * polices.
 */
const MODELS_ASCENDING = [...MODELS].sort();
const DAYS_ASCENDING = ["2026-06-01", "2026-06-02", "2026-06-03"];
const EXPECTED_GROUPS = SESSION_DAYS.length * MODELS.length;

/** Distinct per (day, model), so a dropped or duplicated group is visible. */
function costFor(dayIndex: number, modelIndex: number): number {
  return (dayIndex + 1) * 100 + modelIndex + 1;
}

function tokensFor(dayIndex: number, modelIndex: number): number {
  return costFor(dayIndex, modelIndex) * 1000;
}

describeIfDb("fetchModelUsageRows ordering (ISS-8052)", () => {
  /**
   * The suite's own precondition, EXECUTED rather than asserted in prose.
   *
   * Every ordering case below can only fail on a missing `ORDER BY` while this
   * database actually emits grouped rows out of order. When the planner reaches
   * for a sorted aggregate instead, an unordered query returns ascending rows by
   * accident and those cases go green AGAINST the bug — measured on the CI lane
   * itself (run 33023343075): the ordering cases stayed green with the
   * production `ORDER BY` deleted, and this probe was the only thing that
   * noticed.
   *
   * The seed now pins the aggregate strategy (see the file docstring) so the
   * precondition holds rather than depending on how much data the rest of the
   * tier left behind. This probe stays, unchanged in what it asserts, because
   * pinning it is not the same as proving it: it asserts nothing about
   * production — it asserts that the ENVIRONMENT can still tell an ordered read
   * from an unordered one, so a Postgres upgrade, a retired planner GUC, or a
   * seed that stops applying the isolation fails HERE, with a reason, instead of
   * leaving a green suite that guards nothing.
   *
   * A plan assertion was tried first and rejected: `EXPLAIN` over a
   * near-miss of the statement reported a HashAggregate in exactly the run where
   * the suite could not detect the bug, so it was a false green of its own.
   *
   * THE SHAPE HERE MUST STAY A NEAR-MISS OF PRODUCTION, differing ONLY in the
   * absent `ORDER BY`. The `SUM`s and the scope predicate are carried even
   * though this probe reads neither, because both feed the aggregate's cost and
   * memory estimates: a thinner SELECT is a cheaper hash and can land on a
   * HashAggregate in a run where the real query, with only its `ORDER BY`
   * removed, still picks an accidentally ordered plan — which would make this
   * probe green while the cases it vouches for stayed vacuous. The predicate
   * comes from `sessionScopeSql` rather than a copy for the same reason.
   */
  it("emits grouped rows OUT of order without an ORDER BY, so this file can fail", async () => {
    const unordered = await withCorpus((ctx) =>
      withDb((db) =>
        db.$queryRaw<
          { day: string; model: string; cost: number; tokens: number }[]
        >(
          Prisma.sql`
            SELECT
              to_char(
                date_trunc(
                  'day',
                  (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                ),
                'YYYY-MM-DD'
              ) AS day,
              tu.model AS model,
              SUM(tu.estimated_cost)::float8 AS cost,
              SUM(
                tu.input_tokens + tu.output_tokens
                + tu.cache_read_tokens + tu.cache_write_tokens
              )::float8 AS tokens
            FROM agent_session_token_usage tu
            JOIN session_detail s ON s.artifact_id = tu.agent_session_id
            JOIN artifacts a ON a.id = s.artifact_id
            WHERE s.session_started_at >= ${WINDOW_START}
              AND s.session_started_at <= ${WINDOW_END}
              AND (${sessionScopeSql(ctx)})
            GROUP BY day, tu.model
          `
        )
      )
    );

    expect(unordered).toHaveLength(EXPECTED_GROUPS);
    expect(
      unordered.map((row) => [row.day, row.model]),
      "an unordered GROUP BY came back already sorted on this database, so removing the production ORDER BY would be invisible and every ordering case in this file has stopped being able to fail — the seed's pinHashAggregate() is what is supposed to prevent this, so check that enable_sort/enable_incremental_sort still exist and still reach the query's connection before trusting a green run here"
    ).not.toEqual(expectedPairs());
  });

  it("emits (day, model) groups in ascending order", async () => {
    const { rows } = await withCorpus((ctx) =>
      fetchModelUsageRows(ctx, WINDOW_START, WINDOW_END)
    );

    // The whole contract in one comparison. `expectedPairs` enumerates the days
    // and models from the seed constants, so a query that emitted a different
    // order — or dropped a group — disagrees here on the first call rather than
    // on whichever run the plan happens to change.
    expect(rows.map((row) => [row.day, row.model])).toEqual(expectedPairs());
  });

  it("emits the same order on repeated calls", async () => {
    // The property the golden fixture actually depends on. Weaker on its own
    // than the case above (a stable-but-wrong order satisfies it), which is why
    // it does not stand alone.
    const orders = await withCorpus(async (ctx) => {
      const collected: string[][] = [];
      for (let call = 0; call < 3; call++) {
        const { rows } = await fetchModelUsageRows(
          ctx,
          WINDOW_START,
          WINDOW_END
        );
        collected.push(rows.map((row) => `${row.day}|${row.model}`));
      }
      return collected;
    });

    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
    // Non-vacuous: three empty arrays would satisfy both equalities above.
    expect(orders[0]).toHaveLength(EXPECTED_GROUPS);
  });

  it("still aggregates the right per-(day, model) values", async () => {
    // The positive sibling to the ordering cases: an `ORDER BY` that also broke
    // the grouping, or a window that leaked the out-of-window session, would
    // satisfy an order-only check.
    const { rows } = await withCorpus((ctx) =>
      fetchModelUsageRows(ctx, WINDOW_START, WINDOW_END)
    );

    expect(byPair(rows)).toEqual(expectedValues());
  });

  it("orders the timezone-bucketed groups too", async () => {
    // `day` is a SELECT alias over a DIFFERENT expression on this path (the
    // zone-shifted bucket), and the zone arrives as a bound parameter. What is
    // under test is that the ordering survives that query, not the bucketing —
    // the sessions sit at midday UTC so the day keys are unchanged by the shift.
    const { rows, bucketZone } = await withCorpus((ctx) =>
      fetchModelUsageRows(
        { ...ctx, timeZone: "America/Chicago" },
        WINDOW_START,
        WINDOW_END,
        "America/Chicago"
      )
    );

    expect(bucketZone).toBe("America/Chicago");
    expect(rows.map((row) => [row.day, row.model])).toEqual(expectedPairs());
  });

  it("excludes another organization's token usage", async () => {
    // Without this, every case above would also pass on a query that had lost
    // its org predicate: the second org seeds the SAME models on the SAME days,
    // so a leak reads as duplicated groups rather than as unfamiliar keys.
    const scoped = await autoRollbackTransaction(async () => {
      const ctx = await seedCorpus();
      await seedCorpus();
      return await fetchModelUsageRows(ctx, WINDOW_START, WINDOW_END);
    });

    expect(scoped.rows).toHaveLength(EXPECTED_GROUPS);
    expect(byPair(scoped.rows)).toEqual(expectedValues());
  });
});

/** Every (day, model) pair the seed produces, in the contract's order. */
function expectedPairs(): string[][] {
  return DAYS_ASCENDING.flatMap((day) =>
    MODELS_ASCENDING.map((model) => [day, model])
  );
}

/**
 * Expected sums keyed by `day|model`, built from the seed's own constants and
 * order-free by construction, so this checks the values without restating the
 * ordering assertion.
 */
function expectedValues(): Record<string, { cost: number; tokens: number }> {
  const expected: Record<string, { cost: number; tokens: number }> = {};
  SESSION_DAYS.forEach((day, dayIndex) => {
    MODELS.forEach((model, modelIndex) => {
      expected[`${day.toISOString().slice(0, 10)}|${model}`] = {
        cost: costFor(dayIndex, modelIndex),
        // Four token columns are summed into the one `tokens` figure.
        tokens: tokensFor(dayIndex, modelIndex) * 4,
      };
    });
  });
  return expected;
}

function byPair(
  rows: { day: string; model: string; cost: number; tokens: number }[]
): Record<string, { cost: number; tokens: number }> {
  return Object.fromEntries(
    rows.map((row) => [
      `${row.day}|${row.model}`,
      { cost: row.cost, tokens: row.tokens },
    ])
  );
}

/** Seed a corpus, run one read against it, and roll the whole thing back. */
function withCorpus<T>(
  read: (ctx: InsightsScopeContext) => Promise<T>
): Promise<T> {
  return autoRollbackTransaction(async () => {
    const ctx = await seedCorpus();
    return await read(ctx);
  });
}

async function seedCorpus(): Promise<InsightsScopeContext> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);

  await withDb(async (db) => {
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `token-order-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    });

    const createSession = async (startedAt: Date, label: string) => {
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: `token-order-session-${label}`,
          status: SESSION_STATUS.INACTIVE,
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: artifact.id,
          computeTargetId: computeTarget.id,
          externalSessionId: `token-order-ext-${artifact.id}`,
          harness: "claude",
          sessionStartedAt: startedAt,
          sessionUpdatedAt: startedAt,
          lastActivityAt: startedAt,
        },
        select: { artifactId: true },
      });
      return artifact.id;
    };

    for (const [dayIndex, startedAt] of SESSION_DAYS.entries()) {
      const agentSessionId = await createSession(startedAt, `${dayIndex}`);
      await db.agentSessionTokenUsage.createMany({
        data: MODELS.map((model, modelIndex) => ({
          agentSessionId,
          model,
          inputTokens: BigInt(tokensFor(dayIndex, modelIndex)),
          outputTokens: BigInt(tokensFor(dayIndex, modelIndex)),
          cacheReadTokens: BigInt(tokensFor(dayIndex, modelIndex)),
          cacheWriteTokens: BigInt(tokensFor(dayIndex, modelIndex)),
          estimatedCost: costFor(dayIndex, modelIndex),
        })),
      });
    }

    // A session outside the window carrying the same models, so a lost date
    // bound reads as a fourth day rather than as nothing at all.
    const outsideId = await createSession(OUT_OF_WINDOW, "outside");
    await db.agentSessionTokenUsage.createMany({
      data: MODELS.map((model, modelIndex) => ({
        agentSessionId: outsideId,
        model,
        inputTokens: BigInt(tokensFor(0, modelIndex)),
        estimatedCost: costFor(0, modelIndex),
      })),
    });
  });

  // Real row counts rather than page-based guesses, so the aggregate is costed
  // the way production costs it. This is realism, NOT the thing that makes the
  // file able to fail — see the file docstring: an `ANALYZE`d database still
  // hands back accidentally-ascending rows once it carries anything else.
  // On the SEEDING connection, not the ISS-5978 fixture one: this corpus lives
  // inside `autoRollbackTransaction`, so a second backend would gather
  // statistics from a table that is, to it, still unseeded. The helper refuses a
  // role that cannot ANALYZE rather than letting Postgres skip it silently.
  await withDb((db) =>
    analyzeOnSeedingConnection(db, SEEDED_TABLES, "the ISS-8052 token corpus")
  );
  await pinHashAggregate();

  return { organizationId, userId: user.id, scope: InsightsScope.Org };
}

/** The tables the corpus seeds, and the ones the aggregate's plan is costed from. */
const SEEDED_TABLES = [
  "agent_session_token_usage",
  "session_detail",
  "artifacts",
] as const;

/**
 * Price the sorted plans out of contention for the rest of this transaction, so
 * an unordered `GROUP BY` lands on a HashAggregate and emits its groups in
 * hash-bucket order — the precondition every ordering case in this file needs in
 * order to be able to fail. See the file docstring for why hoping for that plan
 * is not enough: it holds on a freshly migrated database and stops holding as
 * soon as the database carries anything else, which is the state CI runs this
 * file in.
 *
 * This constrains the PLANNER, never the semantics. `enable_sort` is a cost
 * knob, not a capability switch, so an explicit `ORDER BY` is still honoured —
 * Postgres sorts anyway because the clause requires it. That asymmetry is the
 * whole mechanism: after this call an ordered read and an unordered one stop
 * being indistinguishable.
 *
 * `SET LOCAL` reverts with the surrounding rolled-back transaction, so nothing
 * leaks to the next test or to a pooled connection. It is also only meaningful
 * ON that transaction's connection, so the settings are read back rather than
 * assumed: a `withDb` that ever stopped routing through the ambient transaction
 * would otherwise turn this into a silent no-op and hand back a green suite.
 */
async function pinHashAggregate(): Promise<void> {
  const [applied] = await withDb(async (db) => {
    await db.$executeRawUnsafe("SET LOCAL enable_sort = off");
    await db.$executeRawUnsafe("SET LOCAL enable_incremental_sort = off");
    return await db.$queryRaw<{ sort: string; incremental: string }[]>(
      Prisma.sql`
        SELECT current_setting('enable_sort') AS sort,
               current_setting('enable_incremental_sort') AS incremental
      `
    );
  });

  if (applied?.sort !== "off" || applied?.incremental !== "off") {
    throw new Error(
      `planner isolation did not take effect (enable_sort=${applied?.sort}, enable_incremental_sort=${applied?.incremental}) — the ordering cases in this file cannot fail without it, so they would report a guarantee they are no longer testing`
    );
  }
}
