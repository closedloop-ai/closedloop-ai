/**
 * @file regen-golden-sync-checks.test.ts
 * @description ISS-4754 (Golden Layer 5.1) — unit coverage for the pure decision
 * logic of the golden sync-payload producer (`scripts/regen-golden-sync-checks.ts`).
 *
 * This test is the other half of the tooling-reach bargain: the regen SHELL stays
 * ledger-exempt (its `main()` runs at module scope and does real filesystem work)
 * only because the decisions it makes are executed here.
 *
 * The cases that matter are the ones where a green run would otherwise be
 * worthless: a second dossier going null-normalized, a corpus that shrank, and a
 * fixture set with no chunked member at all.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyDossier,
  expectedFixtureFileNames,
  fixtureFilesToPrune,
  KNOWN_NULL_NORMALIZED_DOSSIER_ID,
  type ManifestEntry,
  manifestSanityViolations,
  SYNC_FIXTURE_MANIFEST_VERSION,
  type SyncFixtureManifest,
} from "../scripts/regen-golden-sync-checks.js";

const EXPECTED = { dossiers: 3, syncable: 2 };

// Top-level per useTopLevelRegex: a literal inside a frequently-called test body
// is recompiled on every invocation.
const DROP_CASE = /empty-session DROP case/;
const NO_SHRINK = /must not silently shrink the golden corpus/;
const DOSSIERS_TOTAL = /corpus\.dossiers_total=3/;
const SHRUNKEN = /shrunken population/;
const ZERO_COVERAGE = /ZERO corpus coverage/;
const FORCED_CHUNK = /forced-chunk variant/;
const NO_REASON = /skipped without a recorded reason/;
const TWO_PARTS = /must carry at least two parts/;

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    sessionId: "dossier-a",
    kind: "session",
    chunks: 1,
    harness: "claude",
    dataRevision: 89,
    schemaVersion: 2,
    payloadBytes: 1024,
    ...overrides,
  };
}

function manifest(entries: ManifestEntry[]): SyncFixtureManifest {
  return {
    manifestVersion: SYNC_FIXTURE_MANIFEST_VERSION,
    provenance: {
      compress: false,
      activityChunkingSupported: false,
      maxBytes: 262_018,
      regenCommand: "pnpm --filter desktop run regen:golden-sync-payloads",
      generatedBy: "apps/desktop/scripts/regen-golden-sync-payloads.ts",
    },
    entries,
  };
}

function healthyManifest(): SyncFixtureManifest {
  return manifest([
    entry({ sessionId: "dossier-a" }),
    entry({ sessionId: "dossier-b", kind: "chunked", chunks: 3 }),
    entry({
      sessionId: KNOWN_NULL_NORMALIZED_DOSSIER_ID,
      kind: "skipped",
      chunks: 0,
      skipReason: "normalized.json is null (empty-session DROP case)",
    }),
  ]);
}

describe("classifyDossier", () => {
  test("a dossier with normalized output is syncable", () => {
    assert.deepEqual(
      classifyDossier({ sessionId: "dossier-a", normalized: { a: 1 } }),
      { kind: "syncable" }
    );
  });

  test("the ONE known null-normalized dossier is skipped with a recorded reason", () => {
    const decision = classifyDossier({
      sessionId: KNOWN_NULL_NORMALIZED_DOSSIER_ID,
      normalized: null,
    });
    assert.equal(decision.kind, "skipped");
    assert.match(decision.kind === "skipped" ? decision.reason : "", DROP_CASE);
  });

  test("ANY OTHER null-normalized dossier THROWS rather than shrinking the corpus", () => {
    // The population hole this closes: a swallowed second null would be written
    // to neither the manifest nor the fixture dir, so a manifest<->directory
    // check still reconciles while Layer 5 quietly asserts against fewer sessions.
    assert.throws(
      () => classifyDossier({ sessionId: "dossier-new", normalized: null }),
      NO_SHRINK
    );
  });
});

describe("manifestSanityViolations", () => {
  test("a healthy manifest reports nothing", () => {
    assert.deepEqual(manifestSanityViolations(healthyManifest(), EXPECTED), []);
  });

  test("a shrunken syncable population is a violation, measured against the SIGNED counts", () => {
    const shrunk = manifest([
      entry({ sessionId: "dossier-b", kind: "chunked", chunks: 3 }),
      entry({
        sessionId: KNOWN_NULL_NORMALIZED_DOSSIER_ID,
        kind: "skipped",
        chunks: 0,
        skipReason: "null",
      }),
    ]);
    const violations = manifestSanityViolations(shrunk, EXPECTED);
    assert.equal(violations.length, 2);
    assert.match(violations.join("\n"), DOSSIERS_TOTAL);
    assert.match(violations.join("\n"), SHRUNKEN);
  });

  test("zero chunked fixtures is a violation — the chunk path would have no coverage", () => {
    const unchunked = manifest([
      entry({ sessionId: "dossier-a" }),
      entry({ sessionId: "dossier-b" }),
      entry({
        sessionId: KNOWN_NULL_NORMALIZED_DOSSIER_ID,
        kind: "skipped",
        chunks: 0,
        skipReason: "null",
      }),
    ]);
    const violations = manifestSanityViolations(unchunked, EXPECTED);
    assert.equal(violations.length, 1);
    assert.match(violations[0], ZERO_COVERAGE);
    assert.match(violations[0], FORCED_CHUNK);
  });

  test("a skip without a reason is a violation", () => {
    const unexplained = manifest([
      entry({ sessionId: "dossier-a" }),
      entry({ sessionId: "dossier-b", kind: "chunked", chunks: 2 }),
      entry({
        sessionId: KNOWN_NULL_NORMALIZED_DOSSIER_ID,
        kind: "skipped",
        chunks: 0,
      }),
    ]);
    const violations = manifestSanityViolations(unexplained, EXPECTED);
    assert.equal(violations.length, 1);
    assert.match(violations[0], NO_REASON);
  });

  test("a chunked entry carrying one part is a violation", () => {
    const single = manifest([
      entry({ sessionId: "dossier-a" }),
      entry({ sessionId: "dossier-b", kind: "chunked", chunks: 1 }),
      entry({
        sessionId: KNOWN_NULL_NORMALIZED_DOSSIER_ID,
        kind: "skipped",
        chunks: 0,
        skipReason: "null",
      }),
    ]);
    const violations = manifestSanityViolations(single, EXPECTED);
    assert.equal(violations.length, 1);
    assert.match(violations[0], TWO_PARTS);
  });
});

describe("expectedFixtureFileNames", () => {
  test("names a file for every syncable entry and none for a skip", () => {
    assert.deepEqual(expectedFixtureFileNames(healthyManifest()), [
      "dossier-a.synced-session.json",
      "dossier-b.synced-session.json",
    ]);
  });
});

describe("fixtureFilesToPrune", () => {
  test("prunes an orphaned fixture the manifest no longer names", () => {
    assert.deepEqual(
      fixtureFilesToPrune(
        [
          "dossier-a.synced-session.json",
          "dossier-b.synced-session.json",
          "dossier-gone.synced-session.json",
        ],
        healthyManifest()
      ),
      ["dossier-gone.synced-session.json"]
    );
  });

  test("leaves the Layer 5.3 cloud snapshots and the manifest alone", () => {
    // The regression this guards: the fixtures directory is SHARED. Pruning
    // every `.json` the sync manifest does not name deleted both frozen cloud
    // responses on each routine Layer 5.1 regen, and this producer cannot
    // recreate either — only the Layer 5.3 writer can.
    assert.deepEqual(
      fixtureFilesToPrune(
        [
          "dossier-a.synced-session.json",
          "corpus-insights.utc.json",
          "corpus-insights.chicago.json",
          "manifest.json",
        ],
        healthyManifest()
      ),
      []
    );
  });
});
