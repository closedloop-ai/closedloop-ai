/**
 * ISS-4916 (codex review): electron-log's file transport resolves the PRODUCTION
 * log path until `initializePersistentLogging` configures the redirect, so every
 * durable write before that point — the macOS GPU-workaround line, the
 * single-instance-lock line, the userData-migration lines — landed in the
 * operator's real `main.log` even on a redirected (e2e / golden / --user-data-dir)
 * launch. That is the exact interleaving the ticket exists to stop.
 *
 * These pin the buffering rules that fix it, without booting Electron.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PreInitLogBuffer } from "../src/main/logging/pre-init-log-buffer.js";

const LEVEL_INFO = "info";
const LEVEL_WARN = "warn";

test("lines written before initialization are held, not written", () => {
  const buffer = new PreInitLogBuffer<string>(10);

  assert.equal(
    buffer.capture(LEVEL_INFO, "gpu workaround applied"),
    true,
    "the buffer takes responsibility for the line, so the caller must not write it"
  );
  assert.equal(buffer.capture(LEVEL_WARN, "userData migration failed"), true);

  assert.deepEqual(buffer.drain(), [
    { level: LEVEL_INFO, line: "gpu workaround applied" },
    { level: LEVEL_WARN, line: "userData migration failed" },
  ]);
});

test("draining is one-way, so the replay cannot be re-buffered", () => {
  const buffer = new PreInitLogBuffer<string>(10);
  buffer.capture(LEVEL_INFO, "held");

  const drained = buffer.drain();
  assert.equal(drained.length, 1);

  assert.equal(
    buffer.capture(LEVEL_INFO, "held"),
    false,
    "replaying a drained line must fall through to the real transport"
  );
  assert.equal(
    buffer.capture(LEVEL_INFO, "after init"),
    false,
    "post-initialization writes are never buffered"
  );
  assert.deepEqual(buffer.drain(), [], "a drained buffer holds nothing");
});

test("the buffer is bounded and keeps the EARLIEST lines", () => {
  // A launch path that exits before initializing (the single-instance-lock quit)
  // must not let this grow without bound, and the boot record it exists to
  // preserve is at the front.
  const buffer = new PreInitLogBuffer<string>(2);

  buffer.capture(LEVEL_INFO, "first");
  buffer.capture(LEVEL_INFO, "second");
  assert.equal(
    buffer.capture(LEVEL_INFO, "third"),
    true,
    "an over-cap line is still the buffer's responsibility — it must not be written early"
  );

  assert.deepEqual(buffer.drain(), [
    { level: LEVEL_INFO, line: "first" },
    { level: LEVEL_INFO, line: "second" },
  ]);
  assert.equal(buffer.dropped, 1);
});
