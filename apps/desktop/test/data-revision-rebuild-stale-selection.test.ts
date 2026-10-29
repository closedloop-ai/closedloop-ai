/**
 * @file data-revision-rebuild-stale-selection.test.ts
 * @description ISS-8601 — the admission rule for a stale-revision row.
 *
 * `classifyStaleRow` is the ONE answer the selection and both in-transaction
 * rebuild guards share, so it is pinned here directly rather than only through a
 * pass. The clock is an explicit argument: no fake global timers, nothing
 * relative to `Date.now()`, and therefore no shared clock to leak into a
 * neighbouring case.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyStaleRow,
  StaleRowAdmission,
} from "../src/main/collectors/engine/data-revision.js";
import { groupTerminalStaleByHarness } from "../src/main/collectors/engine/data-revision-rebuild-stale-selection.js";
import { SESSION_TIMESTAMP_EPOCH } from "../src/main/database/session-timestamp-form.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

/** `n` hours before {@link NOW}, as the stored ISO string. */
function hoursAgo(n: number): string {
  return new Date(NOW.getTime() - n * HOUR_MS).toISOString();
}

function counters(): { skippedActive: number; wedgedActiveAdmitted: number } {
  return { skippedActive: 0, wedgedActiveAdmitted: 0 };
}

describe("ISS-8601: classifyStaleRow", () => {
  test("a terminal row is rebuildable regardless of age", () => {
    for (const status of ["inactive", "error"]) {
      assert.equal(
        classifyStaleRow({ status, lastActivityAt: hoursAgo(0) }, NOW),
        StaleRowAdmission.Terminal,
        `${status} is terminal even when it just ended`
      );
    }
  });

  test("a non-terminal row silent past the bound is WEDGED, not live", () => {
    assert.equal(
      classifyStaleRow({ status: "active", lastActivityAt: hoursAgo(48) }, NOW),
      StaleRowAdmission.WedgedNonTerminal
    );
    assert.equal(
      classifyStaleRow(
        { status: "running", lastActivityAt: hoursAgo(48) },
        NOW
      ),
      StaleRowAdmission.WedgedNonTerminal,
      "the bound is about silence, not about which non-terminal spelling"
    );
  });

  test("a non-terminal row active within the bound is a LIVE capture", () => {
    assert.equal(
      classifyStaleRow({ status: "active", lastActivityAt: hoursAgo(1) }, NOW),
      StaleRowAdmission.LiveCapture
    );
  });

  test("the bound is STRICTLY greater than 24h, at both sides of the edge", () => {
    // Mirrors `isSessionDisplayStale`'s strict `elapsedMs >`. Exactly at the
    // threshold the row is still live; one millisecond past it is wedged.
    assert.equal(
      classifyStaleRow({ status: "active", lastActivityAt: hoursAgo(24) }, NOW),
      StaleRowAdmission.LiveCapture,
      "exactly 24h is NOT yet stale"
    );
    assert.equal(
      classifyStaleRow(
        {
          status: "active",
          lastActivityAt: new Date(
            NOW.getTime() - 24 * HOUR_MS - 1
          ).toISOString(),
        },
        NOW
      ),
      StaleRowAdmission.WedgedNonTerminal,
      "24h + 1ms is stale"
    );
  });

  test("FAILS CLOSED: an anchor we cannot read is treated as a live capture", () => {
    // A row whose age cannot be established is never assumed dead. Each of these
    // would otherwise be admitted to a rebuild on no evidence at all.
    for (const lastActivityAt of [
      undefined,
      null,
      "",
      "not-a-timestamp",
    ] as const) {
      assert.equal(
        classifyStaleRow({ status: "active", lastActivityAt }, NOW),
        StaleRowAdmission.LiveCapture,
        `an anchor of ${JSON.stringify(lastActivityAt)} must not admit the row`
      );
    }
  });

  test("the 1970 DEFAULT fails closed — it is a default, not evidence", () => {
    // `sessions.last_activity_at` is NOT NULL with this default, and the isolated
    // import's INSERT omits the column: the real value lands in a LATER
    // write-queue group. So a row whose import is still in flight — and durably
    // any row whose import was evicted between those groups — carries it.
    //
    // It is the one unestablished anchor that PARSES, so it would otherwise read
    // as 56 years silent and be admitted. Admitting it would tear a session down
    // mid-import and stamp over the DATA_REVISION_IMPORT_PENDING sentinel that
    // exists so an interrupted import re-heals instead of sealing with derived
    // rows missing.
    assert.equal(
      classifyStaleRow(
        { status: "active", lastActivityAt: SESSION_TIMESTAMP_EPOCH },
        NOW
      ),
      StaleRowAdmission.LiveCapture
    );
  });

  test("a terminal row at the epoch default is still rebuildable", () => {
    // The fail-closed arm is about not tearing down a LIVE import. A terminal row
    // is not one, so the sentinel must not start refusing the ordinary cohort.
    assert.equal(
      classifyStaleRow(
        { status: "inactive", lastActivityAt: SESSION_TIMESTAMP_EPOCH },
        NOW
      ),
      StaleRowAdmission.Terminal
    );
  });
});

describe("ISS-8601: groupTerminalStaleByHarness", () => {
  test("admits terminal and wedged rows, skips live ones, and counts each", () => {
    const summary = counters();
    const grouped = groupTerminalStaleByHarness(
      [
        {
          id: "t",
          harness: "claude",
          status: "inactive",
          lastActivityAt: hoursAgo(1),
        },
        {
          id: "w",
          harness: "claude",
          status: "active",
          lastActivityAt: hoursAgo(48),
        },
        {
          id: "l",
          harness: "claude",
          status: "active",
          lastActivityAt: hoursAgo(1),
        },
      ],
      summary,
      NOW
    );

    assert.deepEqual([...(grouped.get("claude") ?? [])].sort(), ["t", "w"]);
    assert.equal(summary.skippedActive, 1, "only the live capture is skipped");
    assert.equal(
      summary.wedgedActiveAdmitted,
      1,
      "the wedged row is counted so the backstop firing is visible in the log"
    );
  });

  test("a terminal row does NOT inflate the wedged counter", () => {
    const summary = counters();
    groupTerminalStaleByHarness(
      [
        {
          id: "t",
          harness: "claude",
          status: "inactive",
          lastActivityAt: hoursAgo(99),
        },
      ],
      summary,
      NOW
    );
    assert.equal(summary.wedgedActiveAdmitted, 0);
  });

  test("an admitted wedged row keeps its harness grouping", () => {
    const summary = counters();
    const grouped = groupTerminalStaleByHarness(
      [
        {
          id: "a",
          harness: "codex",
          status: "active",
          lastActivityAt: hoursAgo(48),
        },
        {
          id: "b",
          harness: null,
          status: "active",
          lastActivityAt: hoursAgo(48),
        },
      ],
      summary,
      NOW
    );
    assert.deepEqual([...(grouped.get("codex") ?? [])], ["a"]);
    assert.deepEqual(
      [...(grouped.get("") ?? [])],
      ["b"],
      "a null harness keys ''"
    );
  });

  test("a row with no anchor at all is skipped, not grouped", () => {
    // The shape every pre-ISS-8601 test double still returns.
    const summary = counters();
    const grouped = groupTerminalStaleByHarness(
      [{ id: "x", harness: "claude", status: "active" }],
      summary,
      NOW
    );
    assert.equal(grouped.size, 0);
    assert.equal(summary.skippedActive, 1);
    assert.equal(summary.wedgedActiveAdmitted, 0);
  });
});
