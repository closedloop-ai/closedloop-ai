/**
 * @file canonical-instant-guard-partition.test.ts
 * @description ISS-7579: the two halves of the canonical-instant guard are
 * written as exact complements over the SAME `token_events.created_at`
 * population — `branch-metric-event-provenance.ts` ADMITS what
 * `branch-usage-event-window-sql.ts` EXCLUDES from its window pushdown. Nothing
 * enforced that. Widen the admit set without widening the exclude set and
 * in-window Branch spend disappears from the card WHILE
 * `buildDesktopBranchCostEvidence` still reports full coverage: a wrong number
 * whose completeness signal says it is fine.
 *
 * BOTH predicates here are read from PRODUCTION text — the exclude side by
 * calling the real `branchUsageEventWindowSql`, the admit side by capturing the
 * SQL the real provenance reader emits. Neither is transcribed. A test holding
 * its own copy of either predicate is the failure mode this file exists to
 * prevent: it would stay green while production drifted underneath it.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { createBranchMetricEventEvidenceMethods } from "../src/main/database/branch-metric-event-provenance.js";
import {
  branchUsageEventWindowSql,
  CANONICAL_INSTANT_RE,
} from "../src/main/database/branch-usage-event-window-sql.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  storedUtcDaySql,
} from "../src/main/database/session-timestamp-form.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { captureEmittedStatements } from "./sql-capture-prisma.js";

/**
 * The shape classes, one row each. Which atom each isolates is stated because
 * it decides whether the row may be dropped — three of them are load-bearing
 * and the rest are breadth.
 *
 * Measured atom truth table (`GLOB` / `substr(…,12,2) <= '23'` / round-trip):
 * canonical 1/1/1 · hour-24 1/0/1 · Feb-30 1/1/0 · offset 0/1/0 ·
 * missing-ms 0/1/0 · date-only 0/1/0 · unparseable 0/0/0 · NULL n/a.
 */
const FIXTURES = [
  // The only fixture every atom accepts.
  { id: "canonical", value: "2026-06-22T10:00:00.000Z", admitted: true },
  // LOAD-BEARING: the only fixture isolating `substr(…, 12, 2) <= '23'`.
  // SQLite echoes hour 24 back verbatim, so the round-trip arm accepts it and
  // the glob matches; only the hour predicate rejects it.
  { id: "hour-24", value: "2026-06-22T24:00:00.000Z", admitted: false },
  // LOAD-BEARING: the only fixture isolating the strftime round-trip arm.
  // Feb 30 is canonical by shape and in-range by hour, but SQLite rolls it to
  // Mar 02, so the round-trip differs from the stored text.
  { id: "impossible-date", value: "2026-02-30T10:00:00.000Z", admitted: false },
  // Breadth. These three share one {glob=0, round-trip=0} signature, so they do
  // not add independent atom coverage — they pin the real-world shapes a
  // non-canonical corpus actually contains.
  {
    id: "offset-form",
    value: "2026-06-22T05:00:00.000-05:00",
    admitted: false,
  },
  { id: "missing-ms", value: "2026-06-22T10:00:00Z", admitted: false },
  { id: "date-only", value: "2026-06-22", admitted: false },
  // Breadth: trips all three atoms at once.
  { id: "unparseable", value: "not-a-timestamp", admitted: false },
  // LOAD-BEARING: the only fixture reaching the exclude side's `IS NULL` arm.
  // Every other arm is NULL for a NULL instant, so without that arm a null
  // would fall through and be dropped. `token_events.created_at` is TEXT NOT
  // NULL, which is exactly why this corpus is synthetic rather than seeded.
  { id: "null", value: null, admitted: false },
] as const;

// Far-future and BOTH ends: the window arm must be FALSE for every fixture, so
// the emitted exclude predicate reduces to its four shape arms on this corpus.
// A start-only or past bound makes the window arm TRUE for everything and the
// partition assertion would pass while proving nothing.
const WINDOW_START = "2099-01-01T00:00:00.000Z";
const WINDOW_END = "2099-01-02T00:00:00.000Z";

const ADMIT_SPAN_START =
  "SELECT DISTINCT session_id FROM admitted_activity_segments\n         )";
const ADMIT_SPAN_END =
  "AND (\n             (metric_bounds.start_iso IS NOT NULL";

// Hoisted per AGENTS.md (`useTopLevelRegex`): the message each throw branch of
// the extraction guard must produce.
const NO_ANCHOR_MATCH_RE =
  /expected exactly one emitted statement carrying both ADMIT anchors, got 0/;
const AMBIGUOUS_STATEMENT_RE = /got 2/;
const DUPLICATE_ANCHOR_RE = /must each match exactly once/;
const SPAN_NOT_AND_RE = /does not open with AND/;

const openStores: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.allSettled(openStores.map((close) => close()));
});

async function openStore(): Promise<DesktopPrisma> {
  const { prisma, close } = await openTestPrisma();
  openStores.push(close);
  return prisma;
}

/**
 * The ADMIT chain as production spells it, taken as the SPAN between two named
 * anchors rather than one regex per known atom.
 *
 * Arm-count agnostic on purpose: a per-atom regex would silently return the
 * same three arms after someone adds a fourth, so the partition would still
 * hold and this suite would stay green through the exact drift it guards. The
 * span also has to be taken whole because the same statement carries lookalikes
 * a few lines up — `substr(te.created_at, 21, 3)` (different offset) and
 * `strftime('%s', te.created_at)` (different format) in the SELECT list.
 */
function extractAdmitPredicate(statements: string[]): string {
  const matching = statements.filter(
    (sql) => sql.includes(ADMIT_SPAN_START) && sql.includes(ADMIT_SPAN_END)
  );
  if (matching.length !== 1) {
    throw new Error(
      `expected exactly one emitted statement carrying both ADMIT anchors, got ${matching.length}. ` +
        "The provenance query was reformatted — re-derive the anchors rather than loosening them."
    );
  }
  const sql = matching[0];
  const startCount = sql.split(ADMIT_SPAN_START).length - 1;
  const endCount = sql.split(ADMIT_SPAN_END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `ADMIT anchors must each match exactly once (start=${startCount}, end=${endCount}).`
    );
  }
  const span = sql
    .slice(
      sql.indexOf(ADMIT_SPAN_START) + ADMIT_SPAN_START.length,
      sql.indexOf(ADMIT_SPAN_END)
    )
    .trim();
  if (!span.startsWith("AND ")) {
    throw new Error(`extracted ADMIT span does not open with AND: ${span}`);
  }
  return span.slice("AND ".length);
}

async function admitPredicate(): Promise<string> {
  const statements = await captureEmittedStatements((prisma) =>
    createBranchMetricEventEvidenceMethods(
      prisma
    ).readBranchMetricEventEvidence({
      bounds: { startIso: WINDOW_START, endIso: WINDOW_END },
      branchKeys: [{ repoFullName: "acme/web", branchName: "feature/x" }],
    })
  );
  return extractAdmitPredicate(statements);
}

/** The EXCLUDE chain as production emits it, minus its leading `AND`. */
function excludePredicate(params: unknown[]): string {
  const emitted = branchUsageEventWindowSql(
    { startIso: WINDOW_START, endIso: WINDOW_END },
    params
  );
  const trimmed = emitted.trim();
  if (!trimmed.startsWith("AND ")) {
    throw new Error(
      `expected branchUsageEventWindowSql to open with AND: ${trimmed}`
    );
  }
  return trimmed.slice("AND ".length);
}

/**
 * The corpus rows as positional binds. Returned as a fresh array so it can be
 * handed to `branchUsageEventWindowSql` as its `params` accumulator: that
 * builder numbers its bound placeholders from `params.length + 1`, so the
 * corpus binds MUST already occupy $1..$2N before it runs or its window bounds
 * would collide with them.
 */
function corpusParams(): unknown[] {
  return FIXTURES.flatMap((fixture) => [fixture.id, fixture.value]);
}

const CORPUS_VALUES = FIXTURES.map(
  (_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`
).join(", ");

/** Run a predicate over the fixture corpus, aliased `te` as production spells it. */
async function idsMatching(
  prisma: DesktopPrisma,
  predicate: string,
  params: unknown[]
): Promise<string[]> {
  const rows = await prisma.read((client) =>
    client.$queryRawUnsafe<{ id: string }[]>(
      `WITH te(id, created_at) AS (VALUES ${CORPUS_VALUES})
       SELECT id FROM te WHERE ${predicate}`,
      ...params
    )
  );
  return rows.map((row) => row.id).sort();
}

test("ISS-7579: both guard halves spell the canonical GLOB from the shared constant", async () => {
  // The one check that can catch a one-sided GLOB deletion. It cannot be a
  // behavioral assertion: `strftime('%Y-%m-%dT%H:%M:%fZ', x)` only ever emits a
  // 24-char canonical string, so `strftime(…) IS x` IMPLIES the glob matches,
  // and the glob arm is therefore behaviorally redundant on both sides. Delete
  // it from one side alone and no corpus changes membership — only the text
  // changes. Compared against the imported constant, so this assertion is not
  // itself another copy of the pattern.
  const admit = await admitPredicate();
  const exclude = excludePredicate([]);
  const glob = CANONICAL_UTC_TIMESTAMP_GLOB_SQL;
  assert.equal(
    admit.split(glob).length - 1,
    1,
    "ADMIT must spell the shared canonical GLOB exactly once"
  );
  assert.equal(
    exclude.split(glob).length - 1,
    1,
    "EXCLUDE must spell the shared canonical GLOB exactly once"
  );
});

test("ISS-7579: ADMIT accepts exactly the canonical-comparable shapes", async () => {
  const prisma = await openStore();
  const admitted = await idsMatching(
    prisma,
    await admitPredicate(),
    corpusParams()
  );
  const expected = FIXTURES.filter((fixture) => fixture.admitted)
    .map((fixture) => fixture.id)
    .sort();
  assert.deepEqual(admitted, expected);
});

test("ISS-7579: ADMIT and EXCLUDE partition the same population", async () => {
  // What this catches: an atom added to or removed from ONE side. It holds by
  // boolean algebra for the CURRENT pair, so its value comes entirely from both
  // texts being read from production and from the corpus discriminating each
  // atom — hour-24, the impossible date, and NULL are the rows that make a
  // one-sided edit visible. Do not drop those three.
  const prisma = await openStore();
  // Seed the accumulator with the corpus binds FIRST so the builder's own
  // window placeholders land after them rather than on top of them.
  const excludeParams = corpusParams();
  const exclude = excludePredicate(excludeParams);
  const admitted = await idsMatching(
    prisma,
    await admitPredicate(),
    corpusParams()
  );
  const excluded = await idsMatching(prisma, exclude, excludeParams);

  const overlap = admitted.filter((id) => excluded.includes(id));
  assert.deepEqual(overlap, [], "no row may be both admitted and excluded");

  const union = [...admitted, ...excluded].sort();
  const everything = FIXTURES.map((fixture) => fixture.id).sort();
  assert.deepEqual(
    union,
    everything,
    "every row must land on exactly one side"
  );
});

test("ISS-7579: storedUtcDaySql buckets a date-shaped value and NULLs the rest", async () => {
  // `attribution-day-bucketing.test.ts` is named in this ticket's verification
  // list but runs a raw `substr(created_at, 1, 10)` with no GLOB guard over
  // canonical-only values, so it cannot fail if this helper is wrong.
  const prisma = await openStore();
  const rows = await prisma.read((client) =>
    client.$queryRawUnsafe<{ id: string; day: string | null }[]>(
      `WITH te(id, created_at) AS (VALUES ${CORPUS_VALUES})
       SELECT id, ${storedUtcDaySql("te.created_at")} AS day FROM te`,
      ...corpusParams()
    )
  );
  const byId = new Map(rows.map((row) => [row.id, row.day]));
  // Date-shaped, whatever follows the date: the guard asks only whether a
  // leading `YYYY-MM-DD` is present.
  assert.equal(byId.get("canonical"), "2026-06-22");
  assert.equal(byId.get("hour-24"), "2026-06-22");
  assert.equal(byId.get("impossible-date"), "2026-02-30");
  assert.equal(byId.get("offset-form"), "2026-06-22");
  assert.equal(byId.get("missing-ms"), "2026-06-22");
  assert.equal(byId.get("date-only"), "2026-06-22");
  // Not date-shaped: NULL, never a meaningless 10-character slice.
  assert.equal(byId.get("unparseable"), null);
  assert.equal(byId.get("null"), null);
});

test("ISS-7579: every stored value ADMIT accepts also matches the JS bound regex", async () => {
  // The containment that makes the pushdown a provable superset of the JS
  // filter. Only this direction is required, and only this direction holds:
  // CANONICAL_INSTANT_RE is strictly wider, because it pins shape without the
  // strftime round-trip, so it accepts the impossible-date fixture that ADMIT
  // rejects. Asserting equality here would be asserting something false.
  const prisma = await openStore();
  const admitted = await idsMatching(
    prisma,
    await admitPredicate(),
    corpusParams()
  );
  for (const id of admitted) {
    const fixture = FIXTURES.find((candidate) => candidate.id === id);
    assert.ok(fixture, `unknown admitted fixture ${id}`);
    assert.ok(
      fixture.value !== null && CANONICAL_INSTANT_RE.test(fixture.value),
      `ADMIT accepted ${id} but the bound regex rejects it — a bound of this shape would be pushed down against rows the JS filter keeps`
    );
  }
  // The widening is real and deliberate, not an oversight: pin it so a future
  // narrowing of the regex is a decision someone makes on purpose.
  assert.ok(
    CANONICAL_INSTANT_RE.test("2026-02-30T10:00:00.000Z"),
    "the bound regex is expected to be shape-only and accept an impossible date"
  );
  assert.ok(!admitted.includes("impossible-date"));
});

test("ISS-7579: the ADMIT extraction fails loudly rather than returning a partial span", () => {
  // The guard's whole value is refusing to hand back a plausible-but-wrong
  // predicate after someone reformats the provenance query. Both throw branches
  // are unreachable from the happy path, so they are driven directly.
  assert.throws(() => extractAdmitPredicate(["SELECT 1"]), NO_ANCHOR_MATCH_RE);
  const real = `${ADMIT_SPAN_START}\n           AND x\n           ${ADMIT_SPAN_END}`;
  assert.throws(
    () => extractAdmitPredicate([real, real]),
    AMBIGUOUS_STATEMENT_RE,
    "two statements carrying the anchors must be ambiguous, not first-wins"
  );
  assert.throws(
    () => extractAdmitPredicate([`${ADMIT_SPAN_START}${real}`]),
    DUPLICATE_ANCHOR_RE,
    "a duplicated anchor must fail rather than yield a truncated span"
  );
  assert.throws(
    () =>
      extractAdmitPredicate([
        `${ADMIT_SPAN_START}\n           x\n           ${ADMIT_SPAN_END}`,
      ]),
    SPAN_NOT_AND_RE
  );
});
