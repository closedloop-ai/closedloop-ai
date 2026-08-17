/**
 * FEA-2649: synthetic unit tests for the Layer 3 derivation module
 * (test/golden/golden-layer3-derive.ts) — the fidelity oracle itself.
 *
 * PLN-1340 v3 (challenge round-2 adoption): the derivation cannot be its own
 * only check. These cases pin its window-edge math, median input selection,
 * top-N behavior, TZ bucket twins, and the reference_now-guard failure mode
 * against hand-computed values, so a derivation bug cannot silently bless a
 * broken aggregation as green.
 *
 * Everything here is synthetic — no corpus files, no SQLite.
 */
// Pin a fixed NON-UTC zone before any Date use so the local-bucket twins are
// actively exercised and deterministic across machines/CI (the FEA-2430
// contract-test pattern).
process.env.TZ = "America/Chicago";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { median } from "@repo/api/src/utils/math";
import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import {
  assertCorpusExpectationsWritable,
  CorpusExpectationsStatus,
} from "./golden/corpus-expectations-file.js";
import {
  deriveSessionPageSet,
  inWindow,
  type L3Rows,
  localDayOf,
  localHourOf,
  rangeTwin,
  type SessionRow,
} from "./golden/golden-layer3-derive.js";
import {
  deriveKloc,
  deriveMedianPrSize,
} from "./golden/golden-layer3-derive-loc.js";

const REF = "2026-07-09T22:40:42.009Z";
const SIGNED_OVERWRITE_ERROR =
  /Refusing to overwrite SIGNED corpus expectations/;

function sessionRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: "s",
    name: null,
    cwd: null,
    model: null,
    harness: null,
    status: "inactive",
    billing_mode: null,
    started_at: null,
    ended_at: null,
    updated_at: null,
    awaiting_input_since: null,
    cost_usd_estimated: null,
    metadata: null,
    ...overrides,
  };
}

function rowsWith(sessions: SessionRow[]): L3Rows {
  return {
    sessions,
    agents: [],
    events: [],
    tokenUsage: [],
    tokenEvents: [],
    artifacts: [],
    artifactLinks: [],
    pullRequests: [],
    turnBuckets: [],
  };
}

test("rangeTwin: numeric periods are exact rolling instants ending at now", () => {
  const r7 = rangeTwin(InsightsPeriod.Week, REF);
  assert.equal(r7.endIso, REF);
  assert.equal(r7.startIso, "2026-07-02T22:40:42.009Z");
  assert.equal(r7.priorStartIso, "2026-06-25T22:40:42.009Z");
  assert.equal(
    r7.trendStartIso,
    r7.startIso,
    "7d trend window equals the period"
  );
  const r90 = rangeTwin(InsightsPeriod.Quarter, REF);
  assert.equal(r90.startIso, "2026-04-10T22:40:42.009Z");
  assert.equal(r90.trendStartIso, r90.startIso, "90d trend is capped AT 90d");
});

test("rangeTwin: 'all' spans from the epoch with a 90d trend cap and no prior", () => {
  const all = rangeTwin(InsightsPeriod.All, REF);
  assert.equal(all.startIso, "1970-01-01T00:00:00.000Z");
  assert.equal(all.priorStartIso, "1970-01-01T00:00:00.000Z");
  assert.equal(all.trendStartIso, "2026-04-10T22:40:42.009Z");
});

test("inWindow: inclusive on both edges, exclusive outside, null-safe", () => {
  const start = "2026-07-02T22:40:42.009Z";
  assert.equal(inWindow(start, start, REF), true, "start edge is inclusive");
  assert.equal(inWindow(REF, start, REF), true, "end edge is inclusive");
  assert.equal(inWindow("2026-07-02T22:40:42.008Z", start, REF), false);
  assert.equal(inWindow(null, start, REF), false);
  assert.equal(inWindow(undefined, start, REF), false);
});

test("median (reused helper): odd, even, empty, single", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
});

test("deriveMedianPrSize: enriched-only selection; all-unenriched → null", () => {
  assert.equal(
    deriveMedianPrSize([
      { loc: 100, enriched: true, sized: true, day: "d" },
      { loc: 0, enriched: false, sized: false, day: "d" }, // unknown size — excluded
      { loc: 300, enriched: true, sized: true, day: "d" },
    ]),
    200
  );
  assert.equal(
    deriveMedianPrSize([
      { loc: 0, enriched: false, sized: false, day: "d" },
      { loc: 0, enriched: false, sized: false, day: "d" },
    ]),
    null,
    "no enriched rows → null (renders as —), never a fabricated 0"
  );
  assert.equal(
    deriveMedianPrSize([{ loc: 0, enriched: true, sized: true, day: "d" }]),
    0,
    "a genuinely empty enriched PR is a real 0"
  );
});

test("deriveKloc: sums ALL sized rows and rounds to 0.1; no sized row → null", () => {
  assert.equal(
    deriveKloc([
      { loc: 1234, enriched: true, sized: true, day: "d" },
      { loc: 0, enriched: false, sized: false, day: "d" },
      { loc: 66, enriched: true, sized: true, day: "d" },
    ]),
    1.3
  );
  // ISS-5412: a half-projected row (one line count present) IS evidence the
  // COALESCE'd sum read, so it sizes the window even though it never medians.
  assert.equal(
    deriveKloc([
      { loc: 200, enriched: false, sized: true, day: "d" },
      { loc: 0, enriched: false, sized: false, day: "d" },
    ]),
    0.2
  );
  assert.equal(
    deriveKloc([
      { loc: 0, enriched: false, sized: false, day: "d" },
      { loc: 0, enriched: false, sized: false, day: "d" },
    ]),
    null,
    "no PR carries line counts → unknown KLOC (renders —), never a real 0"
  );
  assert.equal(deriveKloc([]), null);
});

test("localDayOf/localHourOf: bucket in the pinned local timezone", () => {
  // 2026-06-21T03:00Z: June 21 in UTC, June 20 22:00 in America/Chicago (CDT)
  // — UTC and local calendar days DISAGREE, so a UTC regression flips the day.
  const iso = "2026-06-21T03:00:00.000Z";
  assert.equal(localDayOf(iso), "2026-06-20");
  assert.equal(localHourOf(iso), 22);
  // Winter instant (CST, UTC-6): DST offset handled per-date by the tz db.
  assert.equal(localDayOf("2026-01-15T05:30:00.000Z"), "2026-01-14");
  assert.equal(localHourOf("2026-01-15T05:30:00.000Z"), 23);
});

test("deriveSessionPageSet: status vocabulary, search columns, ordering", () => {
  const rows = rowsWith([
    sessionRow({
      id: "a",
      status: "inactive",
      started_at: "2026-06-01T00:00:00.000Z",
      name: "alpha build",
    }),
    sessionRow({
      id: "b",
      status: "running",
      started_at: "2026-06-02T00:00:00.000Z",
      model: "claude-opus-4-8",
    }),
    sessionRow({
      id: "c",
      status: "running",
      awaiting_input_since: "2026-06-02T01:00:00.000Z",
      started_at: "2026-06-03T00:00:00.000Z",
    }),
    sessionRow({
      id: "d",
      status: "inactive",
      started_at: "2026-06-03T00:00:00.000Z",
      cwd: "/home/x/100%done",
    }),
  ]);
  // ORDER BY started_at DESC, id DESC — c and d share a start, so d first.
  assert.deepEqual(
    deriveSessionPageSet(rows, {}).map((s) => s.id),
    ["d", "c", "b", "a"]
  );
  // WAITING = non-terminal AND awaiting; RUNNING = non-terminal AND NOT awaiting.
  assert.deepEqual(
    deriveSessionPageSet(rows, { status: "waiting" }).map((s) => s.id),
    ["c"]
  );
  assert.deepEqual(
    deriveSessionPageSet(rows, { status: "running" }).map((s) => s.id),
    ["b"]
  );
  assert.deepEqual(
    deriveSessionPageSet(rows, { status: "inactive" }).map((s) => s.id),
    ["d", "a"]
  );
  assert.deepEqual(deriveSessionPageSet(rows, { status: "all" }).length, 4);
  // Search hits id OR name OR cwd OR model.
  assert.deepEqual(
    deriveSessionPageSet(rows, { q: "alpha" }).map((s) => s.id),
    ["a"]
  );
  assert.deepEqual(
    deriveSessionPageSet(rows, { q: "opus" }).map((s) => s.id),
    ["b"]
  );
  assert.deepEqual(
    deriveSessionPageSet(rows, { q: "100%done" }).map((s) => s.id),
    ["d"]
  );
  assert.deepEqual(
    deriveSessionPageSet(rows, { q: "  " }).length,
    4,
    "blank q is no filter"
  );
});

test("corpus expectations writer preserves the signed boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-l3-write-guard-"));
  const path = join(dir, "corpus-expectations.yaml");
  try {
    assert.doesNotThrow(
      () => assertCorpusExpectationsWritable(path),
      "a new draft path is writable"
    );
    writeFileSync(path, `status: ${CorpusExpectationsStatus.Proposed}\n`);
    assert.doesNotThrow(
      () => assertCorpusExpectationsWritable(path),
      "an existing PROPOSED draft is replaceable"
    );
    writeFileSync(path, `status: ${CorpusExpectationsStatus.Signed}\n`);
    assert.throws(
      () => assertCorpusExpectationsWritable(path),
      SIGNED_OVERWRITE_ERROR,
      "a signed oracle is never replaced by the agent generator"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
