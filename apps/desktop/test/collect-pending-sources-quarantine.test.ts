/**
 * @file collect-pending-sources-quarantine.test.ts
 * @description ISS-4444 (davetho review): the pre-parse quarantine skip check in
 * `collectPendingSources` must NOT pay a per-source freshness `stat` for the common
 * case of a source with no quarantine entry. It gates the fingerprint read on
 * `quarantine.hasEntry(source)`, so `isQuarantined` (and the `stat` behind it) is
 * only reached for the handful of sources the store actually tracks. These tests
 * pin that structural property via a spy quarantine rather than wall-clock timing.
 *
 * ISS-5028 adds the two READMISSION predicates this module also owns —
 * `recordSourceTimeout`'s "this attempt is terminal" answer and
 * `willSourceBeRescanned`. The first-pass progress tracker reconciles each
 * resume's remaining population against `total - processed`, so it only stays
 * honest while a source counted as finished cannot come back in a later scan.
 */
import assert from "node:assert/strict";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createCatchupCache } from "../src/main/collectors/engine/catchup-cache.js";
import {
  collectPendingSources,
  recordSourceTimeout,
  willSourceBeRescanned,
} from "../src/main/collectors/engine/collector-pending-sources.js";
import {
  createParseQuarantine,
  IMPORT_QUARANTINE_COOLDOWN_MS,
  type ParseQuarantine,
  type QuarantineFingerprint,
} from "../src/main/collectors/engine/parse-quarantine.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import { SourceTimeoutStage } from "../src/shared/ingest-quarantine-contract.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

function makeBatchCollector(sources: string[]): HarnessCollector {
  return {
    key: "opencode",
    cacheName: "opencode",
    batch: true,
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => sources,
    parse: async () => [],
  } as unknown as HarnessCollector;
}

/**
 * A spy quarantine that records which sources `hasEntry`/`isQuarantined` were asked
 * about, and reports an entry only for the paths seeded into `entryPaths`.
 */
function makeSpyQuarantine(entryPaths: Set<string>): {
  quarantine: ParseQuarantine;
  hasEntryCalls: string[];
  isQuarantinedCalls: string[];
} {
  const hasEntryCalls: string[] = [];
  const isQuarantinedCalls: string[] = [];
  const quarantine: ParseQuarantine = {
    hasEntry(source: string): boolean {
      hasEntryCalls.push(source);
      return entryPaths.has(source);
    },
    isQuarantined(
      source: string,
      _fingerprint?: QuarantineFingerprint
    ): boolean {
      isQuarantinedCalls.push(source);
      // A tracked source is treated as still quarantined so the skip path is
      // exercised; this test asserts WHICH sources reach it, not the outcome.
      return entryPaths.has(source);
    },
    recordFailure: () => false,
    clear: () => {},
    quarantinedCount: () => 0,
    quarantinedCountsByStage: () => ({ import: 0, parse: 0 }),
    flush: () => {},
    pruneTo: () => {},
    persisted: false,
  };
  return { quarantine, hasEntryCalls, isQuarantinedCalls };
}

test("ISS-4444: collectPendingSources only consults isQuarantined for sources with an entry", async () => {
  const tracked = "/tmp/poison.jsonl";
  const clean1 = "/tmp/healthy-1.jsonl";
  const clean2 = "/tmp/healthy-2.jsonl";
  const collector = makeBatchCollector([clean1, tracked, clean2]);
  const { quarantine, hasEntryCalls, isQuarantinedCalls } = makeSpyQuarantine(
    new Set([tracked])
  );

  const pending = await collectPendingSources(
    collector,
    undefined,
    [clean1, tracked, clean2],
    undefined,
    undefined,
    quarantine
  );

  // `hasEntry` is consulted for every source (cheap, no I/O)...
  assert.deepEqual(hasEntryCalls, [clean1, tracked, clean2]);
  // ...but the freshness `isQuarantined` check (and its per-source `stat`) is only
  // reached for the one source the store actually tracks. The two healthy sources
  // never pay a stat.
  assert.deepEqual(isQuarantinedCalls, [tracked]);
  // The quarantined source is excluded from the pending set; the two healthy ones
  // remain.
  assert.deepEqual(
    pending.map((p) => p.source).sort(),
    [clean1, clean2].sort()
  );
});

test("ISS-4444: with no tracked entries, collectPendingSources never calls isQuarantined", async () => {
  const sources = ["/tmp/a.jsonl", "/tmp/b.jsonl", "/tmp/c.jsonl"];
  const collector = makeBatchCollector(sources);
  const { quarantine, isQuarantinedCalls } = makeSpyQuarantine(new Set());

  const pending = await collectPendingSources(
    collector,
    undefined,
    sources,
    undefined,
    undefined,
    quarantine
  );

  assert.equal(
    isQuarantinedCalls.length,
    0,
    "no source has an entry, so no freshness stat/isQuarantined is paid"
  );
  assert.deepEqual(pending.map((p) => p.source).sort(), [...sources].sort());
});

/** A file collector whose session id is derivable from the path (FEA-1785). */
function makeFileCollector(): HarnessCollector {
  return {
    key: "claude",
    cacheName: "claude",
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => [],
    parse: async () => [],
    sessionIdForSource: (source: string) => `session:${source}`,
  } as unknown as HarnessCollector;
}

test("ISS-5028: recordSourceTimeout reports the attempt that made the timeout terminal", () => {
  const source = "/tmp/wedged.jsonl";
  let failures = 0;
  const quarantine: ParseQuarantine = {
    hasEntry: () => failures > 0,
    isQuarantined: () => failures >= 2,
    recordFailure: () => {
      failures += 1;
      return failures >= 2;
    },
    clear: () => {},
    quarantinedCount: () => 0,
    quarantinedCountsByStage: () => ({ import: 0, parse: 0 }),
    flush: () => {},
    pruneTo: () => {},
    persisted: false,
  };
  const logged: string[] = [];
  const log = (message: string) => logged.push(message);

  // Still retryable: the source stays unmarked and comes back in the next scan,
  // so the caller must NOT count it as finished.
  assert.equal(
    recordSourceTimeout(
      SourceTimeoutStage.Parse,
      quarantine,
      "claude",
      source,
      null,
      log
    ),
    false
  );
  assert.equal(logged.length, 0);
  // The threshold attempt is terminal: ISS-4444 filters this source out of every
  // later scan, so counting it as non-durable would shrink the denominator.
  assert.equal(
    recordSourceTimeout(
      SourceTimeoutStage.Parse,
      quarantine,
      "claude",
      source,
      null,
      log
    ),
    true
  );
  assert.equal(logged.length, 1, JSON.stringify(logged));

  // No quarantine store at all (a live-watcher pass): nothing is ever terminal.
  assert.equal(
    recordSourceTimeout(
      SourceTimeoutStage.Parse,
      undefined,
      "claude",
      source,
      null,
      log
    ),
    false
  );
});

test("ISS-5028: willSourceBeRescanned answers the orphan readmission, including what this pass just wrote", () => {
  const collector = makeFileCollector();
  const source = "/tmp/transcript.jsonl";
  const sessionId = `session:${source}`;
  const none = new Set<string>();

  // No id snapshot loaded (the collector cannot answer): keep the conservative
  // "will not be readmitted" answer that matches isOrphanedFromDb.
  assert.equal(
    willSourceBeRescanned(collector, source, undefined, none),
    false
  );
  // The row is already in the database: the orphan self-heal leaves it alone.
  assert.equal(
    willSourceBeRescanned(collector, source, new Set([sessionId]), none),
    false
  );
  // Marked seen but nothing in the database — the FEA-2027 unsafe-token-count
  // skip lands here. The next scan readmits it, so it is NOT a finished source.
  assert.equal(willSourceBeRescanned(collector, source, none, none), true);
  // ISS-12036: ...unless this pass parsed the source to ZERO sessions. No row
  // will ever exist under its derived id, so the mark it just wrote keeps the
  // next scan's orphan check off it and the source IS finished. Before this, the
  // zero-session parse shared the readmission above and looped forever.
  assert.equal(
    willSourceBeRescanned(collector, source, none, none, true),
    false
  );
  // ...unless THIS pass wrote the row, which the pre-pass id snapshot cannot
  // know about.
  assert.equal(
    willSourceBeRescanned(collector, source, none, new Set([sessionId])),
    false
  );
  // A batch collector has no path-derivable session id and is never
  // orphan-checked, so it is always treated as finished when it commits.
  assert.equal(
    willSourceBeRescanned(makeBatchCollector([source]), source, none, none),
    false
  );
});

/**
 * ISS-6115 (whitlockk review) — an IMPORT-stage quarantine must not be keyed on the
 * transcript's bytes.
 *
 * A parse wedge is a claim about the BYTES, so ISS-4444's fingerprint is its
 * honest exit. An import stall is a claim about the SINK: a wedged or restarting
 * DB host produces it just as readily as an oversized transcript does. Keying its
 * exit on the bytes means a RECOVERED host still skips an UNCHANGED healthy
 * transcript forever — the eventual-consistency violation `main/sync/AGENTS.md`
 * forbids, since a transient failure must retain retry eligibility.
 *
 * Driven through `recordSourceTimeout` (the production recorder) against a real
 * store with an injected clock, so it also proves the stage is actually STAMPED on
 * the way in rather than only that the store honours one.
 *
 * MUTATION: drop the `stage` argument `recordSourceTimeout` forwards to
 * `recordFailure` and the import entry loads as parse-stage, so the cooldown never
 * applies and the first assertion fails.
 */
test("ISS-6115: an import-stage quarantine expires into a probe; a parse-stage one does not", () => {
  const source = "/tmp/iss-6115-cooldown.jsonl";
  const stat = { mtimeMs: 1000, size: 10 };
  const logs: string[] = [];
  const log = (message: string): void => {
    logs.push(message);
  };
  // A clock the test advances explicitly — never the wall clock (the repo bans
  // timing-based assertions).
  let clockMs = 1_000_000;
  const build = (): ParseQuarantine =>
    createParseQuarantine({ maxAttempts: 2, now: () => clockMs });

  const importStore = build();
  recordSourceTimeout(
    SourceTimeoutStage.Import,
    importStore,
    "codex",
    source,
    stat,
    log
  );
  assert.equal(
    recordSourceTimeout(
      SourceTimeoutStage.Import,
      importStore,
      "codex",
      source,
      stat,
      log
    ),
    true,
    "the second import stall crosses the budget"
  );
  // The transcript has NOT changed — the same fingerprint is presented — and the
  // source is still skipped while the cooldown runs.
  assert.equal(
    importStore.isQuarantined(source, stat),
    true,
    "still quarantined inside the cooldown"
  );
  clockMs += IMPORT_QUARANTINE_COOLDOWN_MS;
  assert.equal(
    importStore.isQuarantined(source, stat),
    false,
    "a recovered sink re-admits the UNCHANGED transcript once the cooldown elapses"
  );
  // One probe, not a fresh budget: a single further stall re-quarantines it, which
  // is what keeps the retry cost bounded.
  assert.equal(
    recordSourceTimeout(
      SourceTimeoutStage.Import,
      importStore,
      "codex",
      source,
      stat,
      log
    ),
    true,
    "the probe re-quarantines on ONE further stall"
  );

  // Positive control on the same predicate and the same clock: a PARSE-stage
  // quarantine is a claim about the bytes, so the cooldown must NOT release it —
  // re-parsing a poison transcript re-pegs a CPU core on every launch.
  const parseStore = build();
  recordSourceTimeout(
    SourceTimeoutStage.Parse,
    parseStore,
    "codex",
    source,
    stat,
    log
  );
  recordSourceTimeout(
    SourceTimeoutStage.Parse,
    parseStore,
    "codex",
    source,
    stat,
    log
  );
  clockMs += IMPORT_QUARANTINE_COOLDOWN_MS * 10;
  assert.equal(
    parseStore.isQuarantined(source, stat),
    true,
    "a parse-stage quarantine never expires on a clock"
  );
  // ...and its own exit still works: changed bytes re-admit it.
  assert.equal(
    parseStore.isQuarantined(source, { mtimeMs: 2000, size: 20 }),
    false,
    "a parse-stage quarantine still exits on a transcript change"
  );
});

/**
 * ISS-6115 (whitlockk review): a source that has EVER wedged the parser keeps the
 * durable, bytes-keyed quarantine even when a later import also stalls. Otherwise
 * the import cooldown would hand a CPU-pegging transcript back to the parser on a
 * clock, which no sink recovery makes safe.
 */
test("ISS-6115: the stage is sticky to parse, so an import stall cannot put a parse wedge on a cooldown", () => {
  const source = "/tmp/iss-6115-sticky.jsonl";
  const stat = { mtimeMs: 1000, size: 10 };
  const log = (): void => {
    // not under test
  };
  let clockMs = 1_000_000;
  const store = createParseQuarantine({ maxAttempts: 2, now: () => clockMs });

  recordSourceTimeout(
    SourceTimeoutStage.Parse,
    store,
    "codex",
    source,
    stat,
    log
  );
  recordSourceTimeout(
    SourceTimeoutStage.Import,
    store,
    "codex",
    source,
    stat,
    log
  );
  assert.equal(store.isQuarantined(source, stat), true, "it quarantined");

  clockMs += IMPORT_QUARANTINE_COOLDOWN_MS * 10;
  assert.equal(
    store.isQuarantined(source, stat),
    true,
    "the parse claim survives the import cooldown"
  );
});

/**
 * ISS-7306 — the ORPHAN readmission answer must agree between the scan and the
 * predicate for a FOLDED BURST CHILD, and the predicate must claim nothing
 * beyond that.
 *
 * A Codex subagent rollout whose parent is present in the same scan parses to
 * zero sessions by design: `codex-collector.parse` returns `[]` and
 * `foldCodexDescendants` writes the content onto the root parent instead. No
 * row therefore ever carries the child's own path-derived id, so the orphan
 * rule alone calls it readmittable forever — while the scan skips it as burst
 * ahead of that same orphan check. Measured on the ISS-7286 populated store,
 * that disagreement was the WHOLE of the reported gap: 992 of 3,352 codex
 * sources, set-equal to the folded-child set, holding `processed` at 2,360/3,352
 * and leaving a 992-source `unfinished` that keeps `drained` false for the pass.
 *
 * The scan's burst gate is a CONJUNCTION (`status.unchanged && isBurst…`), and
 * the third case below pins the half the predicate deliberately does not model:
 * a burst child whose cache entry is stale IS returned as pending, by the same
 * ordinary `cache.isUnchanged` path that readmits any changed source. Without
 * that case the first two would certify an unconditional agreement that does
 * not hold.
 *
 * MUTATION: drop the `isBurstArtifactSource` short-circuit in
 * `willSourceBeRescanned` and the second assertion fails — the child is reported
 * readmittable while the scan has already skipped it.
 */
test("ISS-7306: a folded burst child is not orphan-readmitted, and only that", async () => {
  const dir = makeTempDir();
  const parent = path.join(dir, "rollout-parent.jsonl");
  const child = path.join(dir, "rollout-child.jsonl");
  const orphan = path.join(dir, "rollout-orphan.jsonl");
  for (const file of [parent, child, orphan]) {
    writeFileSync(file, "{}\n", "utf8");
  }
  const collector = makeBurstCollector(new Set([child]));
  const cache = createCatchupCache();
  const none = new Set<string>();

  // The pass finished all three and marked them seen — the state a later scan
  // starts from. None of them wrote a row under its own derived id.
  for (const file of [parent, child, orphan]) {
    cache.markSeen(file);
  }

  const pending = await collectPendingSources(
    collector,
    cache,
    [parent, child, orphan],
    none
  );
  assert.deepEqual(
    pending.map((entry) => entry.source).sort(),
    [orphan, parent].sort(),
    "the scan readmits the orphans and skips the folded child as burst"
  );

  // ...and the predicate must give the scan's answer, not the orphan rule's.
  assert.equal(
    willSourceBeRescanned(collector, child, none, none),
    false,
    "a folded burst child is durably finished: the scan will not list it again"
  );
  // The orphan rule still holds for everything the burst gate does not cover,
  // so the short-circuit cannot have been widened into "never readmitted".
  assert.equal(
    willSourceBeRescanned(collector, orphan, none, none),
    true,
    "a non-burst source with no row is still readmitted by the orphan self-heal"
  );

  // The boundary the predicate does NOT model: the scan's burst branch also
  // requires `status.unchanged`. Append to the child so its cache entry goes
  // stale, and the scan hands it back — a `cache.isUnchanged` readmission, the
  // category this predicate has never answered for any source.
  appendFileSync(child, "{}\n", "utf8");
  const afterChange = await collectPendingSources(
    collector,
    cache,
    [parent, child, orphan],
    none
  );
  assert.ok(
    afterChange.some((entry) => entry.source === child),
    "a burst child whose bytes changed is pending again, burst or not"
  );
});

/**
 * A file collector shaped like Codex: path-derivable session ids, and a set of
 * sources it reports as folded children of a parent in the same scan.
 */
function makeBurstCollector(
  burstSources: ReadonlySet<string>
): HarnessCollector {
  return {
    key: "codex",
    cacheName: "codex",
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => [...burstSources],
    parse: async () => [],
    sessionIdForSource: (source: string) => `session:${source}`,
    isBurstArtifactSource: (source: string) => burstSources.has(source),
  } as unknown as HarnessCollector;
}

const { makeTempDir } = createTempDirManager("iss7306-");

/**
 * ISS-12036: the readmission half of the same rule, driven through the real
 * scan and a real catchup cache.
 *
 * A Codex root rollout the burst classifier drops — or one with no usable
 * timestamp — parses to an empty session list BY DESIGN, so no row ever lands
 * under the id `sessionIdForSource` derives from its path. `isOrphanedFromDb`
 * was therefore permanently true for it and the scan re-listed, re-parsed and
 * re-dropped it on every pass, holding `sources_remaining` flat at 66 for 48h
 * on the install ISS-12036 measured. ISS-7306 closed the same loop for a folded
 * CHILD rollout, which the scan recognises as a burst ARTIFACT ahead of the
 * orphan check; a root has no parent, so nothing recognised it.
 *
 * Both halves are asserted against a real `createCatchupCache`, so the test
 * fails if the mark is written but not read, or read but not persisted onto the
 * entry — and the final case pins the exit, since a permanent skip would be the
 * "silently drops" half of the same ticket.
 *
 * MUTATION: drop the `yieldedNoSession` short-circuit from `isOrphanedFromDb`
 * and the second assertion re-lists the source.
 */
test("ISS-12036: a source marked as parsing to no session is not readmitted by the orphan self-heal", async () => {
  const dir = makeTempDir("iss12036-no-session-");
  const source = path.join(dir, "transcript.jsonl");
  writeFileSync(source, "{}\n");
  const collector = makeFileCollector();
  const cache = createCatchupCache();
  // No row under the derived id — the zero-session parse's permanent state.
  const noRows = new Set<string>();

  cache.markSeenWith(source, statSync(source));
  assert.deepEqual(
    (await collectPendingSources(collector, cache, [source], noRows)).map(
      (pending) => pending.source
    ),
    [source],
    "an orphaned, marked-seen source is readmitted — the self-heal this rule narrows"
  );

  cache.markSeenWith(source, statSync(source), null, {
    yieldedNoSession: true,
  });
  assert.deepEqual(
    await collectPendingSources(collector, cache, [source], noRows),
    [],
    "once the pass records that it parsed to no session, the scan leaves it alone"
  );

  // The exit: the mark describes THESE bytes. A transcript that grows past the
  // burst window, or gains a timestamp, is re-parsed from scratch.
  appendFileSync(source, '{"later":true}\n');
  assert.deepEqual(
    (await collectPendingSources(collector, cache, [source], noRows)).map(
      (pending) => pending.source
    ),
    [source],
    "a changed transcript is offered again"
  );
});
