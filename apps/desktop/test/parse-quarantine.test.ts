/**
 * @file parse-quarantine.test.ts
 * @description ISS-4444: unit coverage for the persisted parse-quarantine store.
 * A source whose historical parse keeps wedging (a CPU-spin that never settles)
 * is dead-lettered per pass and, after `maxAttempts`, QUARANTINED so it is not
 * re-parsed on every launch. The store survives restarts (best-effort JSON file),
 * so a poison transcript is quarantined once, not every cold start.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createParseQuarantine,
  DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS,
  parseQuarantinePath,
} from "../src/main/collectors/engine/parse-quarantine.js";

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

test("ISS-4444: quarantine persists across restarts (survives a new store over the same path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-"));
  const persistPath = parseQuarantinePath(dir, "claude");
  const source = "/tmp/poison.jsonl";
  try {
    const first = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(first.recordFailure(source), true); // quarantined immediately
    first.flush();
    assert.ok(existsSync(persistPath), "the quarantine file was written");

    // A fresh store over the SAME path (a restart) must still see it quarantined.
    const second = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(second.isQuarantined(source), true);
    assert.equal(second.quarantinedCount(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("ISS-4444: a corrupt persisted file is ignored (starts empty, non-fatal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-corrupt-"));
  const persistPath = parseQuarantinePath(dir, "claude");
  try {
    // Write garbage, then construct — must not throw and must start empty.
    writeFileSync(persistPath, "not json {", "utf8");
    const q = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(q.quarantinedCount(), 0);
    assert.equal(q.isQuarantined("/tmp/anything.jsonl"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444: a failed flush preserves the previous valid store and stays retryable (shafty023 review)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-flushfail-"));
  const persistPath = parseQuarantinePath(dir, "claude");
  const first = "/tmp/first-poison.jsonl";
  const second = "/tmp/second-poison.jsonl";
  try {
    // Write a first valid store and capture its bytes.
    const store = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(store.recordFailure(first), true);
    store.flush();
    assert.ok(existsSync(persistPath), "the first flush wrote the store");
    const validBytes = readFileSync(persistPath);

    // Make the directory read-only so the next flush's same-directory temp write
    // fails BEFORE the atomic rename — the previous valid store must be untouched.
    chmodSync(dir, 0o555);
    assert.equal(store.recordFailure(second), true);
    store.flush(); // best-effort: swallows the write error, leaves store dirty

    assert.deepEqual(
      readFileSync(persistPath),
      validBytes,
      "a failed flush must not truncate or overwrite the previous valid store"
    );
    // No stray temp file leaked into the (still-readable) directory.
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
      "the temp file is cleaned up on failure"
    );

    // Restore write access; the retained dirty flag means the next flush persists
    // BOTH sources (proving the failed flush did not clear dirty).
    chmodSync(dir, 0o755);
    store.flush();
    const reloaded = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(reloaded.isQuarantined(first), true);
    assert.equal(reloaded.isQuarantined(second), true);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444: a persisted entry with a negative attempts count is rejected (Zod boundary)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-negative-"));
  const persistPath = parseQuarantinePath(dir, "claude");
  const source = "/tmp/tampered.jsonl";
  try {
    // A hand-edited/corrupt entry with attempts: -100 must not pass the boundary
    // and delay quarantine for another 103 failures — it is dropped entirely, so
    // the source starts fresh from zero attempts.
    writeFileSync(
      persistPath,
      JSON.stringify({
        version: 1,
        entries: { [source]: { attempts: -100, quarantined: false } },
      }),
      "utf8"
    );
    const q = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(q.isQuarantined(source), false);
    // First recorded failure quarantines it, proving the -100 was discarded (a
    // preserved -100 would need 101 failures to reach the threshold of 1).
    assert.equal(q.recordFailure(source), true);
    assert.equal(q.quarantinedCount(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444: a persisted entry with a non-integer attempts count is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-noninteger-"));
  const persistPath = parseQuarantinePath(dir, "claude");
  const source = "/tmp/fractional.jsonl";
  try {
    writeFileSync(
      persistPath,
      JSON.stringify({
        version: 1,
        entries: { [source]: { attempts: 2.5, quarantined: true } },
      }),
      "utf8"
    );
    const q = createParseQuarantine({ persistPath, maxAttempts: 3 });
    assert.equal(q.isQuarantined(source), false);
    assert.equal(q.quarantinedCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-fp-"));
  const persistPath = parseQuarantinePath(dir, "claude");
  const source = "/tmp/poison.jsonl";
  const original = { mtimeMs: 1000, size: 500 };
  try {
    const first = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(first.recordFailure(source, original), true);
    first.flush();

    // A restart must still see it quarantined at the original fingerprint AND
    // still invalidate it when the fingerprint changes.
    const second = createParseQuarantine({ persistPath, maxAttempts: 1 });
    assert.equal(second.isQuarantined(source, original), true);
    assert.equal(
      second.isQuarantined(source, { mtimeMs: 9999, size: 999 }),
      false,
      "a changed fingerprint invalidates a persisted entry too"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444 (codex P1): a legacy persisted entry without a fingerprint stays quarantined", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-legacy-fp-"));
  const persistPath = parseQuarantinePath(dir, "claude");
  const source = "/tmp/poison.jsonl";
  try {
    // An entry persisted before fingerprinting shipped: no fingerprint key.
    writeFileSync(
      persistPath,
      JSON.stringify({
        version: 1,
        entries: { [source]: { attempts: 3 } },
      }),
      "utf8"
    );
    const q = createParseQuarantine({ persistPath, maxAttempts: 1 });
    // No stored fingerprint → cannot prove change → stays quarantined; a fresh
    // failure then stamps a fingerprint going forward.
    assert.equal(q.isQuarantined(source, { mtimeMs: 1, size: 1 }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444: the threshold defaults to DEFAULT_PARSE_QUARANTINE_MAX_ATTEMPTS; only the injected option overrides it", () => {
  // No option → the conservative default governs quarantine (there is no
  // environment knob; shafty023 review removed PARSE_QUARANTINE_MAX_ATTEMPTS).
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
