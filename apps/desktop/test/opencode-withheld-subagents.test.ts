/**
 * @file opencode-withheld-subagents.test.ts
 * @description ISS-5266: the WITHHELD OpenCode subagent record — the signal that
 * keeps a collector-side under-count from reading as a real zero.
 *
 * ISS-5238 (F2) withholds a dropped root's children rather than re-emitting them
 * at top level. That is right about the session graph and is NOT reopened here;
 * these cases pin the thing it left open — that the withhold now produces a
 * durable, countable record, and that the three states the repo guidance forbids
 * conflating stay apart:
 *
 *   complete      — the store withheld nothing (no record).
 *   incomplete    — N children withheld, with the exact spend they carry.
 *   unavailable   — the withhold set could not be read at all.
 *
 * The fixture stores are real `opencode.db` files read through the real
 * collector, because the SQLite/parse ingest boundary is a trust boundary; the
 * pure window/summing helper is exercised directly where a fixture cannot vary
 * the inputs it needs.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createOpencodeCollector } from "../src/main/collectors/opencode/opencode-collector.js";
import type { OpencodeWithheldSubagentReport } from "../src/main/collectors/opencode/opencode-withheld-subagents.js";
import { buildWithheldSubagentRoot } from "../src/main/collectors/opencode/opencode-withheld-subagents.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  cleanupTempDirs,
  makeSession,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import {
  UNPARSEABLE_TOKENS,
  writeOpencodeDb,
} from "./opencode-store-fixture.js";

afterEach(cleanupTempDirs);

/** The drop reason must name the failing column, hoisted per `useTopLevelRegex`. */
const DROP_REASON_RE = /opencode\.session\.input/;

/** Distinct per-child token counts so a wrong sum cannot coincide with a right one. */
const CHILD_A_TOKENS = 111;
const CHILD_B_TOKENS = 222;

/** Parse `dir`'s store through the real collector, capturing every report. */
async function parseCapturingReports(
  dir: string,
  dbPath: string
): Promise<{
  sessions: NormalizedSession[];
  reports: OpencodeWithheldSubagentReport[];
}> {
  const reports: OpencodeWithheldSubagentReport[] = [];
  const collector = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
    recordWithheld: (report) => {
      reports.push(report);
    },
  });
  const sessions = await collector.parse(dbPath);
  return { sessions, reports };
}

test("ISS-5266: a withheld subtree reports WITHHELD with an exact count and token total", async () => {
  const dir = makeTempDir("opencode-withheld-count-");
  const dbPath = writeOpencodeDb(dir, [
    { id: "ses_root", tokensInput: UNPARSEABLE_TOKENS },
    { id: "ses_child_a", parentId: "ses_root", tokensInput: CHILD_A_TOKENS },
    { id: "ses_child_b", parentId: "ses_root", tokensInput: CHILD_B_TOKENS },
  ]);

  const { sessions, reports } = await parseCapturingReports(dir, dbPath);

  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    [],
    "ISS-5238 F2 stands: neither child is published as its own top-level session"
  );
  assert.equal(reports.length, 1, "one report per completed batch load");
  const [report] = reports;
  assert.equal(report.sourcePath, dbPath);
  assert.equal(report.roots.length, 1, "one record per withheld ROOT");
  const [withheld] = report.roots;
  assert.equal(withheld.rootRawId, "ses_root");
  assert.equal(
    withheld.withheldCount,
    2,
    "the count is the withheld population itself, not a separately-kept tally"
  );
  assert.equal(
    withheld.withheldTokens,
    CHILD_A_TOKENS + CHILD_B_TOKENS,
    "the size of the under-count is EXACT — the children parsed, only their root did not"
  );
  assert.notEqual(
    withheld.withheldTokens,
    0,
    "a withhold must never surface as the zero it currently masquerades as"
  );
});

test("ISS-5266: a root that genuinely has no subagents still reads zero, and that zero stays distinguishable from a withhold", async () => {
  const dir = makeTempDir("opencode-withheld-real-zero-");
  const dbPath = writeOpencodeDb(dir, [{ id: "ses_solo" }]);

  const { sessions, reports } = await parseCapturingReports(dir, dbPath);

  assert.equal(sessions.length, 1, "the root imports normally");
  assert.equal(
    sessions[0].subagents?.length ?? 0,
    0,
    "no subagents — a REAL zero, which this ticket must not make unreachable"
  );
  assert.equal(reports.length, 1, "the store is still reported on");
  assert.deepEqual(
    reports[0].roots,
    [],
    "and it withheld nothing: the empty report is the positive 'complete' claim, not the same value as a zero subagent count"
  );
});

test("ISS-5266: an absent-but-NOT-dropped root still re-emits its children, and records no withhold", async () => {
  const dir = makeTempDir("opencode-withheld-not-dropped-");
  // `ses_root` has no messages, so the parser legitimately returns null for it
  // — an absence, not a failure. ISS-5238's withhold must not swallow this case.
  const dbPath = writeOpencodeDb(dir, [
    { id: "ses_root", withoutMessages: true },
    { id: "ses_child", parentId: "ses_root" },
  ]);

  const { sessions, reports } = await parseCapturingReports(dir, dbPath);

  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    ["opencode-ses_child"],
    "the orphan is re-emitted so no session vanishes (unchanged ISS-5238 boundary)"
  );
  assert.deepEqual(
    reports[0].roots,
    [],
    "nothing was withheld, so nothing may claim missing data"
  );
});

test("ISS-5266: the drop reason rides into the record rather than being flattened to a generic string", async () => {
  const dir = makeTempDir("opencode-withheld-reason-");
  const dbPath = writeOpencodeDb(dir, [
    { id: "ses_root", tokensInput: UNPARSEABLE_TOKENS },
    { id: "ses_child", parentId: "ses_root" },
  ]);

  const { reports } = await parseCapturingReports(dir, dbPath);

  const [withheld] = reports[0].roots;
  assert.match(
    withheld.reason,
    DROP_REASON_RE,
    "the reason names the specific column that failed on the root row, so a user is one hop from the cause rather than reading a generic 'unavailable'"
  );
});

test("ISS-5266: the affected window spans every withheld child, and an untimed child yields UNKNOWN rather than a fabricated instant", () => {
  const timed = buildWithheldSubagentRoot("root", "why", [
    makeSession({
      sessionId: "b",
      startedAt: "2026-08-02T00:00:00.000Z",
      endedAt: "2026-08-02T01:00:00.000Z",
    }),
    makeSession({
      sessionId: "a",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T05:00:00.000Z",
    }),
  ]);
  assert.equal(timed.earliestChildStartedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(
    timed.latestChildEndedAt,
    "2026-08-02T01:00:00.000Z",
    "the window is a min/max across children, not the first child's own span"
  );

  const untimed = buildWithheldSubagentRoot("root", "why", [
    makeSession({ sessionId: "a", startedAt: null, endedAt: null }),
  ]);
  assert.equal(untimed.earliestChildStartedAt, null);
  assert.equal(
    untimed.latestChildEndedAt,
    null,
    "an unknown window stays null — a consumer must never render it as a zero-length one"
  );
  assert.equal(
    untimed.withheldCount,
    1,
    "and the session is still counted as withheld even though its window is unknown"
  );
});

test("ISS-5266: the record survives the store and reaches the diagnostics read, and a healed root retires its claim", async () => {
  const dir = makeTempDir("opencode-withheld-store-");
  const db = await openTestDb(dir);
  try {
    await db.diagnostics.recordOpencodeWithheld(
      {
        sourcePath: "/store/opencode.db",
        roots: [
          {
            rootRawId: "ses_root_a",
            withheldCount: 2,
            reason: "token count -5 is not a valid count",
            withheldTokens: 333,
            withheldCacheTokens: 4444,
            earliestChildStartedAt: "2026-08-01T00:00:00.000Z",
            latestChildEndedAt: "2026-08-01T05:00:00.000Z",
            windowPartial: false,
          },
          {
            rootRawId: "ses_root_b",
            withheldCount: 1,
            reason: "token count -7 is not a valid count",
            withheldTokens: 7,
            withheldCacheTokens: 0,
            earliestChildStartedAt: null,
            latestChildEndedAt: null,
            windowPartial: true,
          },
        ],
      },
      "2026-08-06T00:00:00.000Z"
    );

    const first = await db.diagnostics.getData();
    // The producer must actually SET the field. An absent field is the third
    // state ("cannot tell you") and must never stand in for a real answer.
    assert.ok(first.opencodeWithheld, "the diagnostics read reports the field");
    assert.equal(first.opencodeWithheld.length, 2);
    const rootA = first.opencodeWithheld.find(
      (row) => row.rootRawId === "ses_root_a"
    );
    assert.ok(rootA, "the record crossed the store and came back");
    assert.equal(rootA.withheldCount, 2);
    assert.equal(
      rootA.withheldTokens,
      333,
      "the exact shortfall survives persistence, not just the fact that something is missing"
    );
    assert.equal(rootA.sourcePath, "/store/opencode.db");
    const rootB = first.opencodeWithheld.find(
      (row) => row.rootRawId === "ses_root_b"
    );
    assert.equal(
      rootB?.earliestChildStartedAt,
      null,
      "an unknown window round-trips as unknown, not as an empty string"
    );

    // `ses_root_a` parses again on the next load; `ses_root_b` still does not.
    await db.diagnostics.recordOpencodeWithheld(
      {
        sourcePath: "/store/opencode.db",
        roots: [
          {
            rootRawId: "ses_root_b",
            withheldCount: 1,
            reason: "token count -7 is not a valid count",
            withheldTokens: 7,
            withheldCacheTokens: 0,
            earliestChildStartedAt: null,
            latestChildEndedAt: null,
            windowPartial: true,
          },
        ],
      },
      "2026-08-06T01:00:00.000Z"
    );

    const second = await db.diagnostics.getData();
    assert.ok(second.opencodeWithheld);
    assert.deepEqual(
      second.opencodeWithheld.map((row) => row.rootRawId),
      ["ses_root_b"],
      "a root that started parsing again retires its claim — a stale record would keep reporting data that has since arrived"
    );

    // A load that withholds nothing at all clears the store outright.
    await db.diagnostics.recordOpencodeWithheld(
      { sourcePath: "/store/opencode.db", roots: [] },
      "2026-08-06T02:00:00.000Z"
    );
    const third = await db.diagnostics.getData();
    assert.deepEqual(
      third.opencodeWithheld,
      [],
      "an empty report is a positive 'complete' claim and must be able to clear the last row"
    );
  } finally {
    await db.close();
  }
});

test("ISS-5266: one store's withhold never reconciles another store's rows away", async () => {
  const dir = makeTempDir("opencode-withheld-scope-");
  const db = await openTestDb(dir);
  try {
    await db.diagnostics.recordOpencodeWithheld(
      {
        sourcePath: "/store-one/opencode.db",
        roots: [
          {
            rootRawId: "ses_one",
            withheldCount: 1,
            reason: "bad row",
            withheldTokens: 5,
            withheldCacheTokens: 0,
            earliestChildStartedAt: null,
            latestChildEndedAt: null,
            windowPartial: false,
          },
        ],
      },
      "2026-08-06T00:00:00.000Z"
    );
    await db.diagnostics.recordOpencodeWithheld(
      { sourcePath: "/store-two/opencode.db", roots: [] },
      "2026-08-06T00:01:00.000Z"
    );

    const data = await db.diagnostics.getData();
    assert.ok(data.opencodeWithheld);
    assert.deepEqual(
      data.opencodeWithheld.map((row) => row.rootRawId),
      ["ses_one"],
      "the reconcile is scoped to its own sourcePath — a second store reporting 'complete' must not erase the first store's real shortfall"
    );
  } finally {
    await db.close();
  }
});

test("ISS-5266: billable and cache tokens are reported on separate bases, so the shortfall reconciles against the total it is quoted against", () => {
  // `dashboard-queries.ts` builds the headline total as SUM(input_tokens) +
  // SUM(output_tokens) with the cache columns left out. Folding cache into one
  // figure would print a shortfall that cannot be checked against that total,
  // and for OpenCode cache reads routinely exceed input plus output, so the
  // error would not be a rounding-sized one.
  const root = buildWithheldSubagentRoot("root", "why", [
    makeSession({
      sessionId: "a",
      tokensByModel: {
        "test-model": { input: 10, output: 5, cacheRead: 900, cacheWrite: 90 },
      },
    }),
    makeSession({
      sessionId: "b",
      tokensByModel: {
        "test-model": { input: 1, output: 4, cacheRead: 10, cacheWrite: 0 },
      },
    }),
  ]);

  assert.equal(
    root.withheldTokens,
    20,
    "billable is input + output only, matching the dashboard total's basis"
  );
  assert.equal(
    root.withheldCacheTokens,
    1000,
    "cache is carried separately rather than inflating the billable shortfall"
  );
});

test("ISS-5266: a token aggregate past the JS-safe range reports UNAVAILABLE, never a rounded number", () => {
  // A rounded total under a label claiming an exact shortfall is the same class
  // of lie as the zero this ticket removes, just larger.
  const overflowed = buildWithheldSubagentRoot("root", "why", [
    makeSession({
      sessionId: "a",
      tokensByModel: {
        "test-model": {
          input: Number.MAX_SAFE_INTEGER,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    }),
    makeSession({
      sessionId: "b",
      tokensByModel: {
        "test-model": {
          input: Number.MAX_SAFE_INTEGER,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    }),
  ]);

  assert.equal(
    overflowed.withheldTokens,
    null,
    "an unknowable size is reported as unknown rather than silently rounded"
  );
  assert.equal(
    overflowed.withheldCount,
    2,
    "the sessions are still counted; only their token total is unavailable"
  );
});

test("ISS-5266: a child with no instants marks the window PARTIAL rather than leaving the surviving bounds looking exact", () => {
  const partial = buildWithheldSubagentRoot("root", "why", [
    makeSession({
      sessionId: "a",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T05:00:00.000Z",
    }),
    makeSession({ sessionId: "b", startedAt: null, endedAt: null }),
  ]);

  assert.equal(
    partial.earliestChildStartedAt,
    "2026-08-01T00:00:00.000Z",
    "the bounds still report what IS known"
  );
  assert.equal(
    partial.windowPartial,
    true,
    "but they are a LOWER bound: the skipped child could widen the affected period in either direction"
  );

  const exact = buildWithheldSubagentRoot("root", "why", [
    makeSession({
      sessionId: "a",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T05:00:00.000Z",
    }),
  ]);
  assert.equal(
    exact.windowPartial,
    false,
    "a fully-timed subtree is not flagged partial, so the flag stays meaningful"
  );
});

test("ISS-5266: two stores carrying the SAME raw root id each keep their own row", async () => {
  // An opencode session id is unique only WITHIN a store. Keyed on rootRawId
  // alone, store two's upsert would move store one's row onto its own
  // sourcePath, and the per-store reconcile could never retain both.
  const dir = makeTempDir("opencode-withheld-same-id-");
  const db = await openTestDb(dir);
  try {
    const sharedRootId = "ses_collision";
    await db.diagnostics.recordOpencodeWithheld(
      {
        sourcePath: "/store-one/opencode.db",
        roots: [
          {
            rootRawId: sharedRootId,
            withheldCount: 1,
            reason: "store one bad row",
            withheldTokens: 11,
            withheldCacheTokens: 0,
            earliestChildStartedAt: null,
            latestChildEndedAt: null,
            windowPartial: false,
          },
        ],
      },
      "2026-08-06T00:00:00.000Z"
    );
    await db.diagnostics.recordOpencodeWithheld(
      {
        sourcePath: "/store-two/opencode.db",
        roots: [
          {
            rootRawId: sharedRootId,
            withheldCount: 4,
            reason: "store two bad row",
            withheldTokens: 22,
            withheldCacheTokens: 0,
            earliestChildStartedAt: null,
            latestChildEndedAt: null,
            windowPartial: false,
          },
        ],
      },
      "2026-08-06T00:01:00.000Z"
    );

    const data = await db.diagnostics.getData();
    assert.ok(data.opencodeWithheld);
    const bySource = new Map(
      data.opencodeWithheld.map((row) => [row.sourcePath, row])
    );
    assert.equal(
      data.opencodeWithheld.length,
      2,
      "both stores' claims survive; neither upsert stole the other's row"
    );
    assert.equal(
      bySource.get("/store-one/opencode.db")?.withheldTokens,
      11,
      "store one keeps its own shortfall"
    );
    assert.equal(
      bySource.get("/store-two/opencode.db")?.withheldTokens,
      22,
      "store two keeps its own shortfall"
    );
  } finally {
    await db.close();
  }
});

test("ISS-5266: a failed withhold-record write REFUSES the fingerprint seal, so the store is re-read instead of freezing a false zero", async () => {
  // The fingerprint is what stops unchanged bytes being re-read. If it advances
  // over a record that never landed, the missing spend reads as a real zero
  // forever, because nothing will ever look at that store again.
  const dir = makeTempDir("opencode-withheld-write-fail-");
  const dbPath = writeOpencodeDb(dir, [
    { id: "ses_root", tokensInput: UNPARSEABLE_TOKENS },
    { id: "ses_child_a", parentId: "ses_root", tokensInput: CHILD_A_TOKENS },
  ]);

  let recordCalls = 0;
  const failing = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
    recordWithheld: () => {
      recordCalls += 1;
      return Promise.reject(new Error("disk full"));
    },
  });

  const sessions = await failing.parse(dbPath);
  assert.equal(recordCalls, 1, "the sink was actually invoked");
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    [],
    "the parse still resolves; a record failure does not fail the import itself"
  );
  assert.equal(
    failing.markSourceImported?.(dbPath, undefined),
    false,
    "but the seal is REFUSED, so the source returns as pending and is retried"
  );

  // A subsequent load whose record DOES land seals normally, so the refusal is
  // a retry signal rather than a permanently wedged source.
  const healthy = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint-ok.txt"),
    recordWithheld: () => Promise.resolve(),
  });
  await healthy.parse(dbPath);
  assert.equal(
    healthy.markSourceImported?.(dbPath, undefined),
    true,
    "a load whose record landed seals as usual"
  );
});

test("ISS-5266 (thadeusb review): resetIngestState clears the withhold-write failure too, so a reset collector is not wedged by the PREVIOUS run's failed record", async () => {
  // `resetIngestState` is the "start from a clean slate" seam in the collector
  // interface. It used to clear the fingerprint and the seeded marker but leave
  // `withheldRecordFailed` set, so a reset that followed a failed record
  // inherited half of the last run's state: the stale `true` made
  // `markSourceImported` refuse the seal indefinitely, and the store could never
  // finish importing no matter how many clean passes it was given. That is the
  // exact inverse of the refusal's purpose — it is a RETRY signal, and a reset
  // is precisely the moment the retry is supposed to start over.
  const dir = makeTempDir("opencode-withheld-reset-");
  const dbPath = writeOpencodeDb(dir, [
    { id: "ses_root", tokensInput: UNPARSEABLE_TOKENS },
    { id: "ses_child_a", parentId: "ses_root", tokensInput: CHILD_A_TOKENS },
  ]);

  const collector = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
    recordWithheld: () => Promise.reject(new Error("disk full")),
  });

  await collector.parse(dbPath);
  assert.equal(
    collector.markSourceImported?.(dbPath, undefined),
    false,
    "precondition: the failed record has put the collector in the refusing state"
  );

  collector.resetIngestState?.();

  assert.equal(
    collector.markSourceImported?.(dbPath, undefined),
    true,
    "after a reset the collector starts clean, so the previous run's write failure no longer refuses the seal"
  );
});

test("ISS-5266: the scan verdict is what licenses the COMPLETE reading, and it lands in the same transaction as the reconcile", async () => {
  // An empty withhold set is ambiguous three ways (nothing withheld, nothing
  // imported, failed reconcile) and only the first is complete. The verdict is
  // what tells them apart, so it must not exist without a reconcile behind it.
  const dir = makeTempDir("opencode-withheld-scan-");
  const db = await openTestDb(dir);
  try {
    const beforeAnyScan = await db.diagnostics.getData();
    assert.deepEqual(
      beforeAnyScan.opencodeWithheldScans,
      [],
      "no store has reported, so there is no verdict and the tab must read UNKNOWN"
    );

    await db.diagnostics.recordOpencodeWithheld(
      { sourcePath: "/store-one/opencode.db", roots: [] },
      "2026-08-06T00:00:00.000Z"
    );

    const afterScan = await db.diagnostics.getData();
    assert.deepEqual(afterScan.opencodeWithheld, [], "still nothing withheld");
    assert.deepEqual(
      afterScan.opencodeWithheldScans,
      [
        {
          sourcePath: "/store-one/opencode.db",
          observedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
      "but now a verdict proves it, so the same empty set is a real completeness claim"
    );

    // A later scan of the same store REPLACES its verdict rather than appending,
    // so the recency the surface reports is the store's latest, not its first.
    await db.diagnostics.recordOpencodeWithheld(
      { sourcePath: "/store-one/opencode.db", roots: [] },
      "2026-08-07T00:00:00.000Z"
    );
    const rescanned = await db.diagnostics.getData();
    assert.deepEqual(
      rescanned.opencodeWithheldScans,
      [
        {
          sourcePath: "/store-one/opencode.db",
          observedAt: "2026-08-07T00:00:00.000Z",
        },
      ],
      "one verdict per store, carrying its most recent scan"
    );
  } finally {
    await db.close();
  }
});

test("ISS-5266: a child whose OWN model totals leave the safe range reports UNAVAILABLE, and a later model cannot restore it", () => {
  // Distinct from the across-children overflow above: here ONE child's own
  // per-model sum is already past the safe range, so the split it hands up is
  // unavailable before the root ever adds it. The absorbing rule is the point —
  // a second model contributing a small EXACT count must not resurrect a total
  // whose precision is gone, because the resurrected figure (10 / 14 here)
  // would then be quoted to the reader as the whole shortfall.
  const root = buildWithheldSubagentRoot("root", "why", [
    makeSession({
      sessionId: "a",
      tokensByModel: {
        "model-overflow": {
          input: Number.MAX_SAFE_INTEGER,
          output: Number.MAX_SAFE_INTEGER,
          cacheRead: Number.MAX_SAFE_INTEGER,
          cacheWrite: Number.MAX_SAFE_INTEGER,
        },
        "model-small": { input: 5, output: 5, cacheRead: 7, cacheWrite: 7 },
      },
    }),
  ]);

  assert.equal(
    root.withheldTokens,
    null,
    "an unavailable child split makes the root total unavailable, not 10"
  );
  assert.equal(
    root.withheldCacheTokens,
    null,
    "the cache basis absorbs independently of the billable one, and neither reads as 14"
  );
  assert.equal(
    root.withheldCount,
    1,
    "the child is still counted as withheld — only the size of the hole is unknown"
  );
});

test("ISS-5266: the affected window is a min/max whichever order the children arrive in", () => {
  // The window case above feeds children NEWEST first, which only ever exercises
  // one side of each bound. Oldest-first is the order a `time_created` scan
  // actually produces, and a comparison that kept the latest value seen would
  // report the last child's instants as the whole window — understating the
  // period a period-scoped total is incomplete over.
  const ascending = buildWithheldSubagentRoot("root", "why", [
    makeSession({
      sessionId: "a",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T05:00:00.000Z",
    }),
    makeSession({
      sessionId: "b",
      startedAt: "2026-08-02T00:00:00.000Z",
      endedAt: "2026-08-02T01:00:00.000Z",
    }),
  ]);

  assert.equal(
    ascending.earliestChildStartedAt,
    "2026-08-01T00:00:00.000Z",
    "the earliest bound holds against a later candidate"
  );
  assert.equal(
    ascending.latestChildEndedAt,
    "2026-08-02T01:00:00.000Z",
    "the latest bound advances to a later candidate"
  );
  assert.equal(
    ascending.windowPartial,
    false,
    "every child carried both instants, so the bounds are exact"
  );
});
