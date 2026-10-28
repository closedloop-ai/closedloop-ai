/**
 * @file db-host-durable-log-preinit-buffer.test.ts
 * @description ISS-7882 — what happens to a durable line written BEFORE a sink
 * exists, and to the one past the buffer cap.
 *
 * The db-host child imports ~570 modules before its own module body runs, so
 * there is a real window in which a durable line can be written with no relay
 * installed yet. `PreInitLogBuffer` holds those lines and `drain()` is reachable
 * only from `initializePersistentLogging`, which that process never calls — so
 * before this fix they were held forever, and past the cap
 * `capture` counted them into a `dropped` field NOTHING read. A cap is the right
 * trade; a cap nobody can observe is the same defect one size down.
 *
 * SEPARATE FILE ON PURPOSE. `initialized` and the buffer are module state, and
 * the node lane runs one process per file (`pool: "forks"`, `isolate: true`), so
 * this is the only way to exercise a genuinely virgin `persistent-log` — the
 * sibling `db-host-durable-log-relay.test.ts` initializes the transport in its
 * `before` hook and can never see an un-drained buffer again.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createDbHostDurableLogRelay } from "../src/main/database/db-host/db-host-durable-log.js";
import type { DbHostDurableLogResponse } from "../src/main/database/db-host/db-host-protocol.js";
import {
  MAX_PREINIT_BUFFERED_LINES,
  routeDurableLogsToSink,
  writePersistentLog,
} from "../src/main/logging/durable-log-sink.js";

const SCOPE = "preinit-probe";
const OVERFLOW_NOTICE_RE =
  /\[persistent-log] 1 durable line\(s\) exceeded the \d+-line pre-init buffer and were dropped; the \d+ earliest were kept/;

describe("ISS-7882: pre-install durable lines and the buffer cap", () => {
  test("lines written before the relay are replayed, and the overflow is stated", () => {
    const posted: DbHostDurableLogResponse[] = [];

    // One more than the buffer can hold. Nothing is initialized and no sink is
    // installed, so every one of these is held (or refused) rather than written.
    for (let i = 0; i < MAX_PREINIT_BUFFERED_LINES + 1; i++) {
      writePersistentLog("warn", SCOPE, `pre-install line ${i}`);
    }
    // Length rather than `deepEqual(posted, [])`: `node:assert/strict`'s
    // `deepEqual` is declared `asserts actual is T`, so comparing against an
    // empty literal narrows `posted` to `never[]` for the rest of the scope and
    // every later `push`/index read stops compiling.
    assert.equal(
      posted.length,
      0,
      "nothing can have been relayed yet — the sink does not exist"
    );

    routeDurableLogsToSink(
      createDbHostDurableLogRelay({ post: (m) => posted.push(m) })
    );

    // The kept lines, plus exactly one notice naming the overflow.
    assert.equal(posted.length, MAX_PREINIT_BUFFERED_LINES + 1);
    assert.equal(
      posted[0].line,
      `[${SCOPE}] pre-install line 0`,
      "the buffer keeps the EARLIEST lines, which are the boot record"
    );
    assert.equal(
      posted[MAX_PREINIT_BUFFERED_LINES - 1].line,
      `[${SCOPE}] pre-install line ${MAX_PREINIT_BUFFERED_LINES - 1}`
    );

    const notice = posted.at(-1);
    assert.ok(notice);
    assert.equal(notice.level, "warn");
    assert.match(
      notice.line,
      OVERFLOW_NOTICE_RE,
      "the (cap + 1)-th line is discarded, and the discard is REPORTED — a " +
        "silent drop is the defect this relay exists to end, one size down"
    );
    assert.equal(
      notice.line,
      `[persistent-log] 1 durable line(s) exceeded the ${MAX_PREINIT_BUFFERED_LINES}-line pre-init buffer and were dropped; the ${MAX_PREINIT_BUFFERED_LINES} earliest were kept`,
      "the notice must name both the dropped and kept counts from the buffer"
    );
  });

  test("a line written after the install goes straight through, unbuffered", () => {
    // The drain is one-way: `PreInitLogBuffer.drain` closes the buffer, so a
    // later write must not be re-held. Without this, a relay installed at boot
    // would look correct while every subsequent line queued behind a buffer that
    // will never drain again.
    const posted: DbHostDurableLogResponse[] = [];
    routeDurableLogsToSink(
      createDbHostDurableLogRelay({ post: (m) => posted.push(m) })
    );

    writePersistentLog("info", SCOPE, "post-install line");

    assert.deepEqual(
      posted.map((entry) => entry.line),
      [`[${SCOPE}] post-install line`]
    );
  });
});
