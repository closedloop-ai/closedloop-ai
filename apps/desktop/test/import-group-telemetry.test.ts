/**
 * @file import-group-telemetry.test.ts
 * @description ISS-6003 tests for the per-group import timing report. The wedge
 * this exists for produced `parse 2932ms, import 120003ms` and nothing else, so
 * the contract under test is that a slow group NAMES ITSELF, slowest first, that
 * an EVICTED group is named whatever its duration, and that a healthy import
 * stays silent rather than adding a line per session.
 *
 * Elapsed time is driven by an INJECTED clock, never the wall clock: every
 * threshold case here is exact and instant.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createImportGroupTimer,
  EVICTED_IMPORT_GROUP_FIELD,
  formatSlowImportGroups,
  SLOW_IMPORT_GROUP_LOG_MS,
  SLOW_IMPORT_GROUP_LOG_PREFIX,
} from "../src/main/database/import-group-telemetry.js";

const SLOWEST_FIRST_RE =
  /component_invocations=118000ms analytics_rollup=2500ms/;
const FAST_GROUP_RE = /events=/;
const ALL_GROUPS_TOTAL_RE = /\(all groups 120900ms\)/;
const THRESHOLD_GROUP_RE = /events=1000ms/;
const LINK_SNAPSHOT_RE = /link_snapshot=1040ms/;
const EVICTED_EVENTS_RE = /evicted=events/;
const EVICTED_DURATION_RE = /events=40ms/;
const GATE_ONLY_TOTAL_RE = /\(all groups 5ms\)/;
const EVICTED_SEAL_RE = /evicted=revision_seal/;

/** A clock the test advances by hand, so no case depends on real elapsed time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

test("names the slow groups, slowest first, with the all-group total", () => {
  const line = formatSlowImportGroups(
    "session-1",
    new Map([
      ["events", 400],
      ["component_invocations", 118_000],
      ["analytics_rollup", 2500],
    ])
  );

  assert.ok(line);
  assert.match(
    line,
    new RegExp(`^${SLOW_IMPORT_GROUP_LOG_PREFIX} session-1: `)
  );
  // Slowest first — a reader chasing a wedge should not have to sort the line.
  assert.match(line, SLOWEST_FIRST_RE);
  // Fast groups are omitted from the detail but still counted in the total.
  assert.doesNotMatch(line, FAST_GROUP_RE);
  assert.match(line, ALL_GROUPS_TOTAL_RE);
});

test("stays silent when every group was fast", () => {
  assert.equal(
    formatSlowImportGroups(
      "session-1",
      new Map([
        ["events", 12],
        ["analytics_rollup", 30],
      ])
    ),
    null
  );
});

test("reports a group exactly at the threshold, not just past it", () => {
  const line = formatSlowImportGroups(
    "session-1",
    new Map([["events", SLOW_IMPORT_GROUP_LOG_MS]])
  );

  assert.ok(line);
  assert.match(line, THRESHOLD_GROUP_RE);
});

test("names an evicted group that never crossed the slow threshold", () => {
  // ISS-4572/ISS-6003: the evicted group is the one that was holding the writer
  // when the import was abandoned. Suppressing it because its own measured time
  // was short would drop the only actionable field in the wedge case.
  const line = formatSlowImportGroups(
    "session-1",
    new Map([
      ["session_main_agent", 5],
      ["events", 40],
    ]),
    "events"
  );

  assert.ok(line);
  assert.match(line, EVICTED_EVENTS_RE);
  assert.match(line, EVICTED_DURATION_RE);
});

test("reports an eviction that happened before the group's clock ever started", () => {
  // A group evicted while still QUEUED never ran, so it has no duration. The
  // line must still name it — that is the whole signal for a queued-forever wedge.
  const line = formatSlowImportGroups(
    "session-1",
    new Map([["session_main_agent", 5]]),
    "events"
  );

  assert.ok(line);
  assert.match(line, EVICTED_EVENTS_RE);
  assert.match(line, GATE_ONLY_TOTAL_RE);
});

test("accumulates a label that runs more than once in a pass", async () => {
  // The artifact-link snapshot groups legitimately run twice; a reader needs
  // their combined cost, not whichever run happened to be last.
  const lines: string[] = [];
  const clock = fakeClock();
  const timer = createImportGroupTimer(
    (message) => lines.push(message),
    clock.now
  );
  const advanceBy = (ms: number) => () => {
    clock.advance(ms);
    return Promise.resolve();
  };

  await timer.time("link_snapshot", advanceBy(520));
  await timer.time("link_snapshot", advanceBy(520));
  timer.report("session-1");

  assert.equal(lines.length, 1);
  // 520 + 520 — over the threshold only because the two runs accumulate.
  assert.match(lines[0], LINK_SNAPSHOT_RE);
});

test("times a throwing group and rethrows it unchanged", async () => {
  const lines: string[] = [];
  const clock = fakeClock();
  const timer = createImportGroupTimer(
    (message) => lines.push(message),
    clock.now
  );
  const boom = new Error("group failed");

  await assert.rejects(
    timer.time("events", () => {
      clock.advance(3);
      return Promise.reject(boom);
    }),
    (error: unknown) => error === boom
  );

  timer.report("session-1");
  assert.equal(lines.length, 0, "a fast failure is not slow, so no line");
});

test("an eviction makes the timer report even when nothing was slow", async () => {
  const lines: string[] = [];
  const clock = fakeClock();
  const timer = createImportGroupTimer(
    (message) => lines.push(message),
    clock.now
  );

  await timer.time("events", () => {
    clock.advance(40);
    return Promise.resolve();
  });
  assert.equal(timer.evicted(), false);
  timer.noteEviction("events");

  assert.equal(timer.evicted(), true);
  timer.report("session-1");
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`${EVICTED_IMPORT_GROUP_FIELD}=events`));
});

test("keeps the FIRST eviction — the one that abandoned the import", () => {
  const lines: string[] = [];
  const timer = createImportGroupTimer((message) => lines.push(message));

  timer.noteEviction("events");
  timer.noteEviction("revision_seal");
  timer.report("session-1");

  assert.equal(lines.length, 1);
  assert.match(lines[0], EVICTED_EVENTS_RE);
  assert.doesNotMatch(lines[0], EVICTED_SEAL_RE);
});

test("emits nothing for an import whose groups were all fast", async () => {
  const lines: string[] = [];
  const timer = createImportGroupTimer((message) => lines.push(message));

  await timer.time("events", () => Promise.resolve());
  timer.report("session-1");

  assert.deepEqual(lines, []);
});
