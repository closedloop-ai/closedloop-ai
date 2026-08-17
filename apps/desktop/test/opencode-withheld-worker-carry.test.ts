/**
 * @file opencode-withheld-worker-carry.test.ts
 * @description ISS-5266 (wongk review on #4540): the two defects that made the
 * withheld-subagent record real only on the path production almost never takes.
 *
 * The record works in-process, where the collector's injected sink reaches the
 * store. Both defects are about everything else:
 *
 *  1. THE DROP. A historical/boot import parses in the utility process, on a
 *     throwaway collector built with no sink and no DB handle, so the report was
 *     discarded. Worse, the failure latch that makes `markSourceImported` refuse
 *     a premature seal was armed on THAT instance — never on the main-process
 *     one that actually owns the fingerprint — so the store was sealed over a
 *     record that had not landed, and unchanged bytes are never re-read.
 *
 *  2. THE UPGRADE GAP. A store fingerprinted by the PREVIOUS release is
 *     unchanged, so `listSources()` returns `[]`, `parse` never runs, and no
 *     verdict is ever produced. Every existing install upgrades into a
 *     permanently empty table — and an empty table is exactly the "nothing is
 *     withheld" claim this ticket exists to stop the product making.
 *
 * Plus the FEA-3701 boundary obligation: the report crosses a worker response
 * schema, and a field that schema has not been taught is dropped (silently, in
 * the plain-object branch used here) rather than carried. That round trip is
 * asserted against the REAL schema, not a hand-rolled stand-in.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import { applyParseSideReport } from "../src/main/collectors/engine/collector-manager-pass-resources.js";
import {
  parseHistoricalSource,
  resetWorkerCollectorsForTesting,
} from "../src/main/collectors/engine/historical-parse-source.js";
import {
  createHistoricalParseWorkerParsedResponse,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { createOpencodeCollector } from "../src/main/collectors/opencode/opencode-collector.js";
import type { OpencodeWithheldSubagentReport } from "../src/main/collectors/opencode/opencode-withheld-subagents.js";
import { Harness } from "../src/main/collectors/types.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import {
  UNPARSEABLE_TOKENS,
  writeOpencodeDb,
} from "./opencode-store-fixture.js";

afterEach(cleanupTempDirs);

const CHILD_TOKENS = 321;

/** A store whose single root is unparseable, so its one child is withheld. */
function writeWithholdingStore(dir: string): string {
  return writeOpencodeDb(dir, [
    { id: "ses_root", tokensInput: UNPARSEABLE_TOKENS },
    { id: "ses_child", parentId: "ses_root", tokensInput: CHILD_TOKENS },
  ]);
}

/** The report a withholding store produces, read through the real collector. */
async function reportFromStore(
  dir: string,
  dbPath: string
): Promise<OpencodeWithheldSubagentReport> {
  const reports: OpencodeWithheldSubagentReport[] = [];
  const collector = createOpencodeCollector({
    dataDir: dir,
    recordWithheld: (report) => {
      reports.push(report);
    },
  });
  await collector.parse(dbPath);
  const [report] = reports;
  if (!report) {
    throw new Error("fixture precondition: the store must report a withhold");
  }
  return report;
}

test("ISS-5266: the worker-side parse CARRIES the withheld report instead of dropping it", async () => {
  const dir = makeTempDir("opencode-worker-carry-");
  const dbPath = writeWithholdingStore(dir);
  const priorDataDir = process.env.OPENCODE_DATA_DIR;
  // Point the WORKER's own collector — which it builds itself, with no dataDir
  // to inject — at the fixture store, so this exercises the real
  // `createWorkerCollector` wiring rather than a stand-in.
  process.env.OPENCODE_DATA_DIR = dir;
  resetWorkerCollectorsForTesting();
  try {
    // The real worker entry point — the function that runs INSIDE the utility
    // process, where the collector has no sink. Before this fix it returned bare
    // sessions and the report died here.
    const parsed = await parseHistoricalSource(Harness.OpenCode, dbPath);

    const report = parsed.withheldOpencodeSubagents;
    assert.ok(
      report,
      "the out-of-process parse must return the report as DATA — a sink cannot reach the store from the worker"
    );
    assert.equal(report.sourcePath, dbPath);
    assert.equal(report.roots.length, 1, "one record per withheld root");
    assert.equal(report.roots[0]?.rootRawId, "ses_root");
    assert.equal(
      report.roots[0]?.withheldTokens,
      CHILD_TOKENS,
      "the size of the under-count survives the trip, so it can be quoted exactly"
    );
  } finally {
    if (priorDataDir === undefined) {
      // Assigning `undefined` would store the STRING "undefined".
      Reflect.deleteProperty(process.env, "OPENCODE_DATA_DIR");
    } else {
      process.env.OPENCODE_DATA_DIR = priorDataDir;
    }
    resetWorkerCollectorsForTesting();
  }
});

test("ISS-5266: a non-OpenCode worker parse OMITS the side-report field", () => {
  // Cross-repo/version discipline: an absent optional field is omitted, never
  // serialized as null, so a reader that predates the field sees no key at all.
  const response = createHistoricalParseWorkerParsedResponse("req-1", []);
  assert.equal(response.type, "parsed");
  assert.ok(
    !("withheldOpencodeSubagents" in response),
    "the key must be absent, not present-and-null"
  );
});

test("ISS-5266 (FEA-3701): the report survives the worker response schema round trip", async () => {
  const dir = makeTempDir("opencode-worker-roundtrip-");
  const dbPath = writeWithholdingStore(dir);
  const report = await reportFromStore(dir, dbPath);

  // Build the envelope the worker actually posts, then push it through a
  // structured-clone-equivalent serialization and the REAL boundary schema —
  // the exact path a Parsed response takes from the utility process to main.
  const response = createHistoricalParseWorkerParsedResponse(
    "req-round-trip",
    [],
    report
  );
  const parsed = historicalParseWorkerResponseSchema.safeParse(
    JSON.parse(JSON.stringify(response))
  );

  assert.equal(
    parsed.success,
    true,
    `the envelope carrying a report must validate: ${parsed.success ? "" : JSON.stringify(parsed.error?.issues)}`
  );
  assert.ok(parsed.success && parsed.data.type === "parsed");
  const carried =
    parsed.success && parsed.data.type === "parsed"
      ? parsed.data.withheldOpencodeSubagents
      : undefined;
  assert.ok(
    carried,
    "an unmodelled key is STRIPPED by the plain-object branch, not rejected — which is exactly how this field would go missing in silence"
  );
  assert.deepEqual(
    carried,
    report,
    "every field the record needs must cross the boundary, not just the ones the schema happened to model"
  );
});

test("ISS-5266: the replayed report reaches the store and CLEARS the seal refusal", async () => {
  const dir = makeTempDir("opencode-replay-ok-");
  const dbPath = writeWithholdingStore(dir);
  const report = await reportFromStore(dir, dbPath);

  const recorded: OpencodeWithheldSubagentReport[] = [];
  // The MAIN-process collector: the instance that owns the fingerprint and
  // answers markSourceImported. Its own `parse` never ran — the worker's did.
  const collector = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
    recordWithheld: (incoming) => {
      recorded.push(incoming);
    },
  });

  await applyParseSideReport(collector, {
    sessions: [],
    withheldOpencodeSubagents: report,
  });

  assert.deepEqual(
    recorded,
    [report],
    "the report must be recorded by the instance that owns the fingerprint"
  );
  assert.equal(
    collector.markSourceImported?.(dbPath),
    true,
    "a landed record seals normally"
  );
});

test("ISS-5266: a FAILED replayed record REFUSES the seal, so the store is re-read", async () => {
  const dir = makeTempDir("opencode-replay-fail-");
  const dbPath = writeWithholdingStore(dir);
  const report = await reportFromStore(dir, dbPath);

  const collector = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
    recordWithheld: () => Promise.reject(new Error("store write failed")),
  });

  // Never rejects: sessions that parsed fine must still import. The failure is
  // latched and surfaces as a refused seal.
  await applyParseSideReport(collector, {
    sessions: [],
    withheldOpencodeSubagents: report,
  });

  assert.equal(
    collector.markSourceImported?.(dbPath),
    false,
    "sealing over a record that never landed would freeze the false zero forever — unchanged bytes are never re-read"
  );
});

test("ISS-5266: an UPGRADED install with no recorded scan re-reads its unchanged store once", async () => {
  const dir = makeTempDir("opencode-upgrade-rescan-");
  const dbPath = writeWithholdingStore(dir);
  const fingerprintPath = path.join(dir, "fingerprint.txt");

  // Simulate the previous release: it imported this store and sealed the
  // fingerprint, but never wrote a withheld verdict (the table did not exist).
  const priorRelease = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath,
  });
  await priorRelease.parse(dbPath);
  assert.equal(priorRelease.markSourceImported?.(dbPath), true);

  // Control: the SAME persisted fingerprint, with a scan already recorded, must
  // NOT rescan. Without this the test would pass for a collector that simply
  // ignored its fingerprint, which would rescan every store on every launch.
  const alreadyScanned = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath,
    hasRecordedWithheldScan: () => true,
  });
  assert.deepEqual(
    alreadyScanned.listSources(),
    [],
    "a store with a recorded verdict stays suppressed by its fingerprint"
  );

  // The upgrade: no recorded scan for this store, so it must be re-read ONCE.
  const upgraded = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath,
    hasRecordedWithheldScan: () => false,
  });
  assert.deepEqual(
    upgraded.listSources(),
    [dbPath],
    "an install upgrading from a release that wrote no verdict must re-read, or its table stays empty forever"
  );
});

test("ISS-5266: the upgrade rescan CONVERGES once its verdict is recorded", async () => {
  const dir = makeTempDir("opencode-upgrade-converge-");
  const dbPath = writeWithholdingStore(dir);
  const fingerprintPath = path.join(dir, "fingerprint.txt");

  const priorRelease = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath,
  });
  await priorRelease.parse(dbPath);
  priorRelease.markSourceImported?.(dbPath);

  // The reconciliation launch: no scan recorded yet, so it re-reads, records,
  // and seals. `scanRecorded` flips exactly as the real store's scan row does —
  // written in the same transaction as the reconcile.
  let scanRecorded = false;
  const reconciling = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath,
    hasRecordedWithheldScan: () => scanRecorded,
    recordWithheld: () => {
      scanRecorded = true;
    },
  });
  const sources = reconciling.listSources();
  assert.deepEqual(
    sources,
    [dbPath],
    "the reconciliation pass reads the store"
  );
  await reconciling.parse(dbPath);
  assert.equal(
    reconciling.markSourceImported?.(dbPath),
    true,
    "the verdict landed, so the fingerprint may seal"
  );
  assert.equal(scanRecorded, true);

  // The NEXT launch sees a recorded scan and is suppressed again: one extra
  // load, not a permanent rescan.
  const nextLaunch = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath,
    hasRecordedWithheldScan: () => scanRecorded,
  });
  assert.deepEqual(
    nextLaunch.listSources(),
    [],
    "the rescan must converge after one pass, never repeat every launch"
  );
});
