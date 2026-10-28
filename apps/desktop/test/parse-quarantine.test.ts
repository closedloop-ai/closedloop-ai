/**
 * @file parse-quarantine.test.ts
 * @description ISS-4444: unit coverage for the persisted parse-quarantine store.
 * A source whose historical parse keeps wedging (a CPU-spin that never settles)
 * is dead-lettered per pass and, after `maxAttempts`, QUARANTINED so it is not
 * re-parsed on every launch. The store survives restarts, so a poison transcript
 * is quarantined once, not every cold start.
 *
 * ISS-9838: that durability is now a row in the local SQLite store reached
 * through an injected {@link IngestStorePort}, not a JSON file, so these drive
 * the in-memory port fake and assert on the snapshot the store wrote back.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createParseQuarantine,
  DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS,
} from "../src/main/collectors/engine/parse-quarantine.js";
import { createMemoryIngestStore } from "./ingest-store-test-utils.js";

/**
 * The quarantine format version this suite expects to survive a reload.
 * Declared HERE, independently of the store's own `PERSIST_VERSION`, so the
 * discard test below fails if that constant is deleted or its comparison is
 * removed — a test that read its expectation from the constant it polices
 * could not.
 */
const QUARANTINE_PERSIST_VERSION = 1;

test("ISS-4444: a source is quarantined only after reaching maxAttempts", () => {
  const q = createParseQuarantine({ maxAttempts: 3 });
  const source = "/tmp/poison.jsonl";

  assert.equal(q.isQuarantined(source), false);
  assert.equal(q.recordFailure(source), false); // 1
  assert.equal(q.isQuarantined(source), false);
  assert.equal(q.recordFailure(source), false); // 2
  assert.equal(q.isQuarantined(source), false);
  assert.equal(q.recordFailure(source), true); // 3 → quarantined
  assert.equal(q.isQuarantined(source), true);
  assert.equal(q.quarantinedCount(), 1);
});

test("ISS-4444: a clean parse clears accrued attempts so a transient spin does not accrete", () => {
  const q = createParseQuarantine({ maxAttempts: 2 });
  const source = "/tmp/flaky.jsonl";

  q.recordFailure(source); // 1
  q.clear(source); // parsed cleanly this pass
  assert.equal(q.recordFailure(source), false); // back to 1, not 2
  assert.equal(q.isQuarantined(source), false);
});

test("ISS-4444: quarantine persists across restarts (survives a new store over the same port)", () => {
  const store = createMemoryIngestStore();
  const source = "/tmp/poison.jsonl";
  const first = createParseQuarantine({ store, maxAttempts: 1 });
  assert.equal(first.recordFailure(source), true); // quarantined immediately
  first.flush();
  assert.equal(
    store.peek()?.version,
    QUARANTINE_PERSIST_VERSION,
    "the snapshot is stamped with the current format version"
  );

  // A fresh store over the SAME port (a restart) must still see it quarantined.
  const second = createParseQuarantine({ store, maxAttempts: 1 });
  assert.equal(second.isQuarantined(source), true);
  assert.equal(second.quarantinedCount(), 1);
});

test("ISS-9838: a persisted quarantine at another PERSIST_VERSION is discarded whole", () => {
  // ISS-9837 R3: the version discriminates the STORE's FORMAT, so a snapshot at
  // any other version is dropped entirely rather than partially retained — a
  // retained entry written under a shape this build does not understand would
  // keep skipping a source that must be re-attempted.
  const source = "/tmp/poison.jsonl";
  const seedStore = createMemoryIngestStore();
  const seeded = createParseQuarantine({ store: seedStore, maxAttempts: 1 });
  assert.equal(seeded.recordFailure(source), true);
  seeded.flush();
  const persisted = seedStore.peek();
  assert.ok(persisted, "the seed flush persisted a snapshot");

  for (const version of [
    QUARANTINE_PERSIST_VERSION - 1,
    QUARANTINE_PERSIST_VERSION + 1,
  ]) {
    const store = createMemoryIngestStore({
      version,
      entries: persisted.entries,
    });
    const reloaded = createParseQuarantine({ store, maxAttempts: 1 });
    assert.equal(
      reloaded.isQuarantined(source),
      false,
      `a v${version} snapshot must not quarantine anything`
    );
    assert.equal(
      reloaded.quarantinedCount(),
      0,
      `a v${version} snapshot is discarded wholesale`
    );
  }

  // The same snapshot at the CURRENT version still loads, so the assertions
  // above pin the version comparison rather than a broken hydrate.
  const sameVersion = createParseQuarantine({
    store: createMemoryIngestStore(persisted),
    maxAttempts: 1,
  });
  assert.equal(sameVersion.isQuarantined(source), true);
});

test("ISS-4444: pruneTo drops entries for sources that no longer exist", () => {
  const q = createParseQuarantine({ maxAttempts: 1 });
  const gone = "/tmp/deleted.jsonl";
  const kept = "/tmp/kept.jsonl";
  q.recordFailure(gone);
  q.recordFailure(kept);
  assert.equal(q.quarantinedCount(), 2);
  q.pruneTo([kept]);
  assert.equal(q.isQuarantined(gone), false);
  assert.equal(q.isQuarantined(kept), true);
  assert.equal(q.quarantinedCount(), 1);
});

test("ISS-4444: an absent persisted snapshot is ignored (starts empty, non-fatal)", () => {
  // ISS-9838: an unreadable payload never reaches this constructor — the
  // provider decodes it and hands `hydrated: null` (see
  // `dashboard/ingest-store-provider.ts`), which must not throw and must start
  // empty.
  const q = createParseQuarantine({
    store: createMemoryIngestStore(null),
    maxAttempts: 1,
  });
  assert.equal(q.quarantinedCount(), 0);
  assert.equal(q.isQuarantined("/tmp/anything.jsonl"), false);
});

test("ISS-4444: a failed flush preserves the previous valid snapshot and stays retryable (davetho review)", async () => {
  const port = createMemoryIngestStore();
  const first = "/tmp/first-poison.jsonl";
  const second = "/tmp/second-poison.jsonl";

  // Write a first valid snapshot and capture it.
  const store = createParseQuarantine({ store: port, maxAttempts: 1 });
  assert.equal(store.recordFailure(first), true);
  store.flush();
  const validSnapshot = port.peek();
  assert.ok(validSnapshot, "the first flush wrote the snapshot");

  // Refuse the next write — the previous valid snapshot must be untouched.
  port.failWrites(true);
  assert.equal(store.recordFailure(second), true);
  store.flush(); // best-effort: the refusal must never fail the caller

  assert.deepEqual(
    port.peek(),
    validSnapshot,
    "a failed flush must not overwrite the previous valid snapshot"
  );

  // whitlockk review (ISS-9838): the port refuses ASYNCHRONOUSLY — `save` returning
  // means queued, not accepted — so the retry flag is restored a microtask
  // later. Settle before the retry, or this asserts nothing about the refusal.
  await new Promise((resolve) => setImmediate(resolve));

  // Restore writes; the retained dirty flag means the next flush persists BOTH
  // sources (proving the failed flush did not leave dirty cleared).
  port.failWrites(false);
  store.flush();
  const reloaded = createParseQuarantine({ store: port, maxAttempts: 1 });
  assert.equal(reloaded.isQuarantined(first), true);
  assert.equal(reloaded.isQuarantined(second), true);
});

test("ISS-4444: a persisted entry with a negative attempts count is rejected (Zod boundary)", () => {
  const source = "/tmp/tampered.jsonl";
  // A hand-edited/corrupt entry with attempts: -100 must not pass the boundary
  // and delay quarantine for another 103 failures — it is dropped entirely, so
  // the source starts fresh from zero attempts.
  const q = createParseQuarantine({
    store: createMemoryIngestStore({
      version: QUARANTINE_PERSIST_VERSION,
      entries: { [source]: { attempts: -100, quarantined: false } },
    }),
    maxAttempts: 1,
  });
  assert.equal(q.isQuarantined(source), false);
  // First recorded failure quarantines it, proving the -100 was discarded (a
  // preserved -100 would need 101 failures to reach the threshold of 1).
  assert.equal(q.recordFailure(source), true);
  assert.equal(q.quarantinedCount(), 1);
});

test("ISS-4444: a persisted entry with a non-integer attempts count is rejected", () => {
  const source = "/tmp/fractional.jsonl";
  const q = createParseQuarantine({
    store: createMemoryIngestStore({
      version: QUARANTINE_PERSIST_VERSION,
      entries: { [source]: { attempts: 2.5, quarantined: true } },
    }),
    maxAttempts: 3,
  });
  assert.equal(q.isQuarantined(source), false);
  assert.equal(q.quarantinedCount(), 0);
});

test("ISS-4444 (codex P1): a changed fingerprint invalidates the quarantine so a corrected transcript is re-attempted", () => {
  const q = createParseQuarantine({ maxAttempts: 1 });
  const source = "/tmp/poison.jsonl";
  const original = { mtimeMs: 1000, size: 500 };
  // Quarantined at the original fingerprint.
  assert.equal(q.recordFailure(source, original), true);
  assert.equal(q.isQuarantined(source, original), true);

  // A human corrects the transcript at the same path: mtime/size change. The
  // stale entry must be discarded and the source re-attempted (not skipped
  // forever behind the path-only key).
  const corrected = { mtimeMs: 2000, size: 800 };
  assert.equal(q.isQuarantined(source, corrected), false);
  assert.equal(q.quarantinedCount(), 0, "the stale entry was cleared");
});

test("ISS-4444 (codex P1): a changed fingerprint resets the attempt tally rather than accreting onto the old file", () => {
  const q = createParseQuarantine({ maxAttempts: 2 });
  const source = "/tmp/poison.jsonl";
  const original = { mtimeMs: 1000, size: 500 };
  assert.equal(q.recordFailure(source, original), false); // 1 attempt

  // The file is replaced before it reached the threshold. Its single failure
  // must NOT carry over — the corrected file starts its own tally at 1.
  const corrected = { mtimeMs: 2000, size: 800 };
  assert.equal(q.recordFailure(source, corrected), false); // fresh 1, not 2
  assert.equal(q.isQuarantined(source, corrected), false);
});

test("ISS-4444 (codex P1): a matching fingerprint keeps the source quarantined", () => {
  const q = createParseQuarantine({ maxAttempts: 1 });
  const source = "/tmp/poison.jsonl";
  const fingerprint = { mtimeMs: 1000, size: 500 };
  assert.equal(q.recordFailure(source, fingerprint), true);
  // Same file (unchanged) → stays quarantined.
  assert.equal(q.isQuarantined(source, fingerprint), true);
});

test("ISS-4444 (codex P1): a null fingerprint (unstattable) keeps the source quarantined", () => {
  const q = createParseQuarantine({ maxAttempts: 1 });
  const source = "/tmp/poison.jsonl";
  assert.equal(q.recordFailure(source, { mtimeMs: 1000, size: 500 }), true);
  // Cannot prove the file changed → conservatively stays quarantined.
  assert.equal(q.isQuarantined(source, null), true);
  // Omitting the fingerprint entirely (legacy caller) also stays quarantined.
  assert.equal(q.isQuarantined(source), true);
});

test("ISS-4444 (codex P1): a fingerprint round-trips through persistence", () => {
  const store = createMemoryIngestStore();
  const source = "/tmp/poison.jsonl";
  const original = { mtimeMs: 1000, size: 500 };
  const first = createParseQuarantine({ store, maxAttempts: 1 });
  assert.equal(first.recordFailure(source, original), true);
  first.flush();

  // A restart must still see it quarantined at the original fingerprint AND
  // still invalidate it when the fingerprint changes.
  const second = createParseQuarantine({ store, maxAttempts: 1 });
  assert.equal(second.isQuarantined(source, original), true);
  assert.equal(
    second.isQuarantined(source, { mtimeMs: 9999, size: 999 }),
    false,
    "a changed fingerprint invalidates a persisted entry too"
  );
});

test("ISS-4444 (codex P1): a legacy persisted entry without a fingerprint stays quarantined", () => {
  const source = "/tmp/poison.jsonl";
  // An entry persisted before fingerprinting shipped: no fingerprint key.
  const q = createParseQuarantine({
    store: createMemoryIngestStore({
      version: QUARANTINE_PERSIST_VERSION,
      entries: { [source]: { attempts: 3 } },
    }),
    maxAttempts: 1,
  });
  // No stored fingerprint → cannot prove change → stays quarantined; a fresh
  // failure then stamps a fingerprint going forward.
  assert.equal(q.isQuarantined(source, { mtimeMs: 1, size: 1 }), true);
});

test("ISS-4444: the threshold defaults to DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS; only the injected option overrides it", () => {
  // No option → the conservative default governs quarantine (there is no
  // environment knob; davetho review removed PARSE_QUARANTINE_MAX_ATTEMPTS).
  const withDefault = createParseQuarantine();
  const source = "/tmp/default-threshold.jsonl";
  for (let i = 1; i < DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS; i += 1) {
    assert.equal(withDefault.recordFailure(source), false);
  }
  assert.equal(withDefault.recordFailure(source), true);

  // The injected `maxAttempts` option is the only override, and is floored at 1.
  const withOverride = createParseQuarantine({ maxAttempts: 1 });
  assert.equal(withOverride.recordFailure("/tmp/one-shot.jsonl"), true);
  const flooredToOne = createParseQuarantine({ maxAttempts: 0 });
  assert.equal(flooredToOne.recordFailure("/tmp/floored.jsonl"), true);
});
