import assert from "node:assert/strict";
import test from "node:test";
import { createTracker } from "./helpers/ingest-progress-fixture.js";

// ISS-4917. The first-pass lifecycle lines used to be gated behind a 50-source
// threshold, so a first pass under it emitted nothing at all — no start, no
// progress, no completion. That range is exactly the steady state for an
// already-imported machine, so a stalled import there was invisible in main.log.

const SMALL_PASS_TOTAL = 10;
const LARGE_PASS_TOTAL = 60;
const STALL_WARN_MS = 60_000;
const STALL_CHECK_MS = 15_000;
const ANNOUNCE_RE = /session backfill \[claude\]: importing \d+ source file/;
const COMPLETE_RE = /session backfill \[claude\] first pass complete/;
const STALL_RE = /session backfill \[claude\] NOT ADVANCING/;
const SCAN_STALL_RE = /NOT ADVANCING: the source scan has not finished/;
const PREPARING_RE = /session backfill \[claude\]: preparing/;
const RESUME_RE = /session backfill \[claude\]: resuming with/;
const ABANDON_RE = /session backfill \[claude\] abandoned at/;
const CODEX_STALL_RE = /session backfill \[codex\] NOT ADVANCING/;
const SLOW_LAUNCH_HINT = "first launch can take a while";
// ISS-5028: pulls the reported numerator/denominator out of the periodic line.
const PROGRESS_COUNTS_RE = /: (\d+)\/(\d+) source file\(s\)/;

/** Lines matching `pattern`, for assertions that ignore the surrounding noise. */
function matching(lines: string[], pattern: RegExp): string[] {
  return lines.filter((line) => pattern.test(line));
}

test("a first pass under the old 50-source threshold still announces and completes", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  assert.equal(
    lines.length,
    1,
    `the small first pass announces itself: ${JSON.stringify(lines)}`
  );
  assert.match(lines[0], ANNOUNCE_RE);
  assert.ok(
    lines[0].includes(`importing ${SMALL_PASS_TOTAL} source file(s)`),
    lines[0]
  );
  assert.equal(
    lines[0].includes(SLOW_LAUNCH_HINT),
    false,
    "a small pass does not claim the launch will take a while"
  );

  for (let i = 0; i < SMALL_PASS_TOTAL; i += 1) {
    tracker.advance("claude", 0, 0);
  }
  clock.advanceTo(clock.now() + 4000);
  tracker.settlePass("claude");

  assert.match(lines.at(-1) ?? "", COMPLETE_RE);
  assert.ok(
    (lines.at(-1) ?? "").includes(`${SMALL_PASS_TOTAL} source file(s) in 4s`),
    lines.at(-1)
  );
});

test("a large first pass keeps the slow-first-launch hint", () => {
  const { tracker, lines } = createTracker();

  tracker.beginPass("claude", LARGE_PASS_TOTAL);

  assert.ok(lines[0].includes(SLOW_LAUNCH_HINT), lines[0]);
});

test("the announce is emitted once across a yield/resume re-entry", () => {
  const { tracker, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.beginPass("claude", SMALL_PASS_TOTAL);

  assert.equal(lines.length, 1, JSON.stringify(lines));
});

test("ISS-4715: yield/resume keeps first-pass progress monotonic", () => {
  const { tracker } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.advance("claude", 0, 0);
  assert.deepEqual(tracker.snapshot().byHarness, [
    { harness: "claude", total: SMALL_PASS_TOTAL, processed: 1 },
  ]);

  // The resumed scan reports REMAINING work. It must not replace the lifecycle
  // with a fresh 0/9 pass after the first source already reached a terminal
  // outcome.
  tracker.beginPass("claude", SMALL_PASS_TOTAL - 1);
  assert.deepEqual(tracker.snapshot().byHarness, [
    { harness: "claude", total: SMALL_PASS_TOTAL, processed: 1 },
  ]);

  tracker.advance("claude", 0, 0);
  tracker.beginPass("claude", SMALL_PASS_TOTAL - 2);
  assert.deepEqual(tracker.snapshot().byHarness, [
    { harness: "claude", total: SMALL_PASS_TOTAL, processed: 2 },
  ]);
});

test("ISS-4715: resumed discovery grows progress and final accounting without regressing", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.advance("claude", 0, 0);

  // One new file appeared while yielded: ten remain after one of the original
  // ten completed. Preserve the completed work and grow the tracked population.
  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  assert.deepEqual(tracker.snapshot().byHarness, [
    { harness: "claude", total: SMALL_PASS_TOTAL + 1, processed: 1 },
  ]);
  assert.ok(
    (lines.at(-1) ?? "").includes(
      "resuming with 10 source file(s) still pending; 1 newly discovered (1/11 complete)"
    ),
    lines.at(-1)
  );

  clock.advanceTo(clock.now() + 1000);
  tracker.settlePass("claude");
  assert.ok(
    (lines.at(-1) ?? "").includes("first pass complete: 11 source file(s)"),
    lines.at(-1)
  );
});

test("the periodic progress line stays time-throttled for a small pass", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  for (let i = 0; i < 5; i += 1) {
    clock.advanceTo(clock.now() + 500);
    tracker.advance("claude", 100, 200);
  }
  assert.equal(
    lines.length,
    1,
    `only the announce so far: ${JSON.stringify(lines)}`
  );

  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 600, 1200);

  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.ok(lines[1].includes("6/10 source file(s)"), lines[1]);
});

test("a first pass that stops advancing logs a stall line with its position", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.advance("claude", 0, 0);
  const advancedAt = clock.now();

  clock.advanceTo(advancedAt + STALL_WARN_MS - 1);
  tracker.checkStalls();
  assert.equal(
    lines.filter((line) => STALL_RE.test(line)).length,
    0,
    "nothing is reported before the stall window elapses"
  );

  clock.advanceTo(advancedAt + STALL_WARN_MS);
  tracker.checkStalls();

  const stallLines = matching(lines, STALL_RE);
  assert.equal(stallLines.length, 1, JSON.stringify(lines));
  assert.ok(
    stallLines[0].includes("no source completed in the last 60s"),
    stallLines[0]
  );
  assert.ok(
    stallLines[0].includes("at 1/10 source file(s)"),
    "the stall line carries processed/total"
  );
  assert.ok(stallLines[0].includes("elapsed 60s"), stallLines[0]);
  assert.ok(
    stallLines[0].includes(
      "may still be inside its bounded parse/import window"
    ),
    "the line does not claim more than it knows: a source can legitimately sit inside a 90s parse bound"
  );
});

test("a continuing stall re-reports on the next window and stops once progress resumes", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  const startedAt = clock.now();

  clock.advanceTo(startedAt + STALL_WARN_MS);
  tracker.checkStalls();
  clock.advanceTo(startedAt + STALL_WARN_MS + 30_000);
  tracker.checkStalls();
  assert.equal(
    lines.filter((line) => STALL_RE.test(line)).length,
    1,
    "the re-report is throttled to one per stall window"
  );

  clock.advanceTo(startedAt + 2 * STALL_WARN_MS);
  tracker.checkStalls();
  assert.equal(
    lines.filter((line) => STALL_RE.test(line)).length,
    2,
    "a stall that keeps going keeps reporting"
  );

  // Progress resumes: the stall state clears and a fresh full window is needed.
  tracker.advance("claude", 0, 0);
  clock.advanceTo(clock.now() + STALL_WARN_MS - 1);
  tracker.checkStalls();
  assert.equal(
    lines.filter((line) => STALL_RE.test(line)).length,
    2,
    "advancing resets the stall clock"
  );
});

test("the stall watch is armed on the first pass and torn down when the pass settles", () => {
  const { tracker, clock } = createTracker();

  assert.equal(clock.isArmed(), false, "nothing is scheduled before a pass");
  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  assert.equal(clock.isArmed(), true);
  assert.deepEqual(clock.scheduledIntervals, [STALL_CHECK_MS]);

  tracker.beginPass("codex", SMALL_PASS_TOTAL);
  assert.deepEqual(
    clock.scheduledIntervals,
    [STALL_CHECK_MS],
    "a second harness reuses the one shared sweep"
  );

  tracker.settlePass("claude");
  assert.equal(
    clock.isArmed(),
    true,
    "the sweep stays while another pass is in flight"
  );

  tracker.settlePass("codex");
  assert.equal(clock.isArmed(), false, "the last settle disarms the sweep");
  assert.equal(clock.cancelCount, 1);
});

test("resetForStop tears the stall watch down and clears its state", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.resetForStop();

  assert.equal(clock.isArmed(), false, "stop() never strands the sweep timer");
  clock.advanceTo(clock.now() + 10 * STALL_WARN_MS);
  tracker.checkStalls();
  assert.equal(
    lines.filter((line) => STALL_RE.test(line)).length,
    0,
    "a stopped tracker reports no stalls for its cleared passes"
  );
});

test("a pass parked at the backfill pause is never reported as not advancing", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.noteSuspended("claude");

  clock.advanceTo(clock.now() + 5 * STALL_WARN_MS);
  clock.tick();
  assert.equal(
    matching(lines, STALL_RE).length,
    0,
    `a parked backfill is not stuck: ${JSON.stringify(lines)}`
  );

  // Resuming restarts the window: the parked interval is not time spent stuck.
  tracker.noteResumed("claude");
  clock.advanceTo(clock.now() + STALL_WARN_MS - 1);
  clock.tick();
  assert.equal(
    matching(lines, STALL_RE).length,
    0,
    "the window restarts on resume"
  );

  clock.advanceTo(clock.now() + 1);
  clock.tick();
  assert.equal(
    matching(lines, STALL_RE).length,
    1,
    "a resumed pass that still does not move is reported"
  );
});

test("only the harness that actually parked is muted", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.beginPass("codex", SMALL_PASS_TOTAL);
  // wongk review: the user pausing the backfill flips one shared flag, but a
  // harness whose parse/write is still in flight has NOT parked, so it must keep
  // reporting. Only the harness that reached the pause point is muted.
  tracker.noteSuspended("claude");

  clock.advanceTo(clock.now() + STALL_WARN_MS);
  clock.tick();

  assert.equal(
    matching(lines, STALL_RE).length,
    0,
    `the parked harness is muted: ${JSON.stringify(lines)}`
  );
  assert.equal(
    matching(lines, CODEX_STALL_RE).length,
    1,
    `the still-running harness keeps reporting: ${JSON.stringify(lines)}`
  );
});

test("a pass that yielded to live events is muted until it re-enters", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.advance("claude", 0, 0);
  // The low-duty pass returned early to drain live-watcher events. It is not
  // advancing BY DESIGN, and the resumed pass re-runs the whole source scan
  // before its first advance, so the gap is not a stall.
  tracker.noteSuspended("claude");
  clock.advanceTo(clock.now() + 5 * STALL_WARN_MS);
  clock.tick();
  assert.equal(
    matching(lines, STALL_RE).length,
    0,
    `a yielded pass is not stuck: ${JSON.stringify(lines)}`
  );

  // Re-entry restarts the window rather than reporting the drained interval.
  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  clock.advanceTo(clock.now() + STALL_WARN_MS - 1);
  clock.tick();
  assert.equal(matching(lines, STALL_RE).length, 0, JSON.stringify(lines));
});

test("the source scan reports itself before it can produce a total", () => {
  const { tracker, clock, lines } = createTracker();

  // wongk review: listSources + loadExistingSessionIds + collectPendingSources
  // all run before the first beginPass, so a freeze in there left main.log with
  // no record at all — no start line, no not-advancing line.
  tracker.markPreparing("claude");
  assert.equal(matching(lines, PREPARING_RE).length, 1, JSON.stringify(lines));
  assert.equal(clock.isArmed(), true, "the scan arms the sweep");

  clock.advanceTo(clock.now() + STALL_WARN_MS);
  clock.tick();
  const scanLines = matching(lines, SCAN_STALL_RE);
  assert.equal(scanLines.length, 1, JSON.stringify(lines));
  assert.ok(scanLines[0].includes("after 60s"), scanLines[0]);

  tracker.clearPreparing("claude");
  assert.equal(
    clock.isArmed(),
    false,
    "a finished scan with no pass in flight disarms the sweep"
  );
});

test("a smaller resumed population reconciles completed work without changing the pass total", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", 400);
  // A yield/resume recomputes the REMAINING pending sources, so the re-entry
  // number is smaller. Without carrying the finished sources forward, the top of
  // the pass said 400 and the bottom said 260 with no explanation between them.
  tracker.beginPass("claude", 260);

  const resumeLines = matching(lines, RESUME_RE);
  assert.equal(resumeLines.length, 1, JSON.stringify(lines));
  assert.ok(
    resumeLines[0].includes(
      "resuming with 260 source file(s) still pending; 140 completed while yielded (140/400 complete)"
    ),
    resumeLines[0]
  );

  clock.advanceTo(clock.now() + 5000);
  tracker.settlePass("claude");
  assert.ok(
    (lines.at(-1) ?? "").includes("first pass complete: 400 source file(s) in"),
    lines.at(-1)
  );
});

// ISS-5028 (bot review): `total` is cumulative-for-the-pass, so it can end ABOVE
// the announce when the harness writes new transcripts mid-pass — the ticket's
// 67 → 74. The periodic line and the completion line must then agree on ONE
// population; reporting the announce at completion printed `74/74` and then
// "complete: 67" in the same log stream.
test("a population that grew mid-pass is reported once, not as two numbers", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", 67);
  for (let index = 0; index < 67; index += 1) {
    tracker.advance("claude", 0, 0);
  }
  // Seven transcripts landed while the pass was parked at the live-event yield.
  tracker.beginPass("claude", 7);
  for (let index = 0; index < 7; index += 1) {
    // Past the periodic-line throttle, so the last of these is the line the
    // operator actually sees immediately before the completion line.
    clock.advanceTo(clock.now() + 20_000);
    tracker.advance("claude", 0, 0);
  }

  const lastProgress = matching(lines, PROGRESS_COUNTS_RE).at(-1) ?? "";
  assert.ok(lastProgress.includes("74/74 source file(s)"), lastProgress);

  tracker.settlePass("claude");
  const completion = lines.at(-1) ?? "";
  assert.ok(
    completion.includes("first pass complete: 74 source file(s) in"),
    completion
  );
});

// ISS-5028 (bot review): the reported population may not move because the
// COUNTER changed its mind — only because the source set did. `beginPass`
// reconciles each resume against `total - processed`, so a wrong `durable`
// answer is read as discovery or as completion. Both directions are pinned here.
test("a retried source is not counted twice, and a quarantined one does not shrink the denominator", () => {
  const { tracker, clock, lines } = createTracker();
  const counts = () => {
    const match = PROGRESS_COUNTS_RE.exec(
      matching(lines, PROGRESS_COUNTS_RE).at(-1) ?? ""
    );
    return `${match?.[1]}/${match?.[2]}`;
  };
  const advance = (durable: boolean) => {
    clock.advanceTo(clock.now() + 20_000);
    tracker.advance("claude", 0, 0, durable);
  };

  tracker.beginPass("claude", 3);
  advance(true);
  advance(true);
  // The third source wedges its parse but stays RETRYABLE, so it is left
  // unmarked and comes back. Counting it here would make the resume below report
  // a population of four.
  advance(false);
  assert.equal(counts(), "2/3", JSON.stringify(lines));

  // The resume recomputes the remaining population: the retried source is still
  // pending, so it must not also be in `processed` — otherwise `total -
  // processed` is 0, this one source reads as newly discovered, and the total
  // walks to four.
  tracker.beginPass("claude", 1);

  // This attempt crosses the ISS-4444 quarantine threshold, which drops the
  // source from every LATER scan. Reporting it non-durable would leave the pass
  // reading 2/3 with nothing left to do.
  advance(true);
  assert.equal(counts(), "3/3", JSON.stringify(lines));
});

test("a re-entry that crosses the source threshold earns the slow-launch hint", () => {
  const { tracker, lines } = createTracker();

  tracker.beginPass("claude", 45);
  assert.equal(lines[0].includes(SLOW_LAUNCH_HINT), false, lines[0]);

  tracker.beginPass("claude", 300);

  assert.ok((lines.at(-1) ?? "").includes(SLOW_LAUNCH_HINT), lines.at(-1));
});

test("a pass that rejects is abandoned rather than reported forever", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  tracker.advance("claude", 0, 0);
  // codex review: the bounded importer propagated a db-host transport rejection.
  // runImportFor catches it and returns completed:true, so without this the
  // entry stayed "in flight" and the sweep reported it every window forever.
  tracker.abandonPass("claude", "db-host transport closed");

  const abandonLines = matching(lines, ABANDON_RE);
  assert.equal(abandonLines.length, 1, JSON.stringify(lines));
  assert.ok(
    abandonLines[0].includes("at 1/10 source file(s)"),
    abandonLines[0]
  );
  assert.ok(
    abandonLines[0].includes("db-host transport closed"),
    abandonLines[0]
  );
  assert.equal(
    matching(lines, COMPLETE_RE).length,
    0,
    "an abandoned pass is never reported as complete"
  );
  assert.equal(clock.isArmed(), false, "the sweep is torn down with the pass");

  clock.advanceTo(clock.now() + 10 * STALL_WARN_MS);
  tracker.checkStalls();
  assert.equal(
    matching(lines, STALL_RE).length,
    0,
    "an abandoned pass reports nothing afterwards"
  );

  assert.equal(
    tracker.isFirstPassPending("claude"),
    true,
    "the first-pass gate is NOT set, so the next pass re-tracks"
  );
  assert.equal(
    tracker.snapshot().byHarness.length,
    0,
    "the abandoned pass leaves no stranded progress entry behind"
  );
});

test("the scheduled callback is what drives the sweep", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", SMALL_PASS_TOTAL);
  clock.advanceTo(clock.now() + STALL_WARN_MS);
  clock.tick();

  assert.equal(
    lines.filter((line) => STALL_RE.test(line)).length,
    1,
    `the interval callback runs checkStalls: ${JSON.stringify(lines)}`
  );
});

// ISS-5028. `beginPass` zeroed `processed` on every yield/resume while keeping
// the denominator, so `N/67 source file(s)` reported "sources since the last
// resume" under a label that reads as "progress through the pass" — the operator
// saw "1, then 2, then back to 1" and a starved import was indistinguishable
// from a slow one. Numerator and denominator must describe the same population.

test("the reported numerator is monotonic across resumes within one pass", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", 67);
  const reported: number[] = [];
  const readNumerator = () => {
    // Force the periodic line past its throttle so every step is observable.
    clock.advanceTo(clock.now() + 11_000);
    tracker.advance("claude", 100, 200);
    const [, processed] = PROGRESS_COUNTS_RE.exec(lines.at(-1) ?? "") ?? [];
    reported.push(Number(processed));
  };

  readNumerator();
  readNumerator();
  // A resume re-enters with the RECOMPUTED remaining population, which has even
  // GROWN because the harness kept writing while the pass was parked.
  tracker.beginPass("claude", 66);
  readNumerator();
  tracker.beginPass("claude", 65);
  readNumerator();

  assert.deepEqual(reported, [1, 2, 3, 4], JSON.stringify(lines));
});

test("a resumed pass reports a denominator that is its own population", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", 10);
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 0, 0);
  tracker.advance("claude", 0, 0);
  // Two done, eight left, and one new source appeared while parked: 2/11.
  tracker.beginPass("claude", 9);
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 0, 0);

  assert.ok((lines.at(-1) ?? "").includes("3/11 source file(s)"), lines.at(-1));
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.byHarness, [
    { harness: "claude", total: 11, processed: 3 },
  ]);
});

test("a retried source does not inflate the cumulative denominator", () => {
  // ISS-5028: a parse timeout or a mid-write parse throw completes the source
  // for THIS pass but deliberately leaves it unmarked, so it reappears in the
  // next resume's pending count. Counting it in `processed` too would make
  // `total - processed` one too small, so the retry reads as a newly-discovered
  // source and `total` gains one per attempt — the same class of number as the
  // ticket's "68 of the announced 67".
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", 3);
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 0, 0, true);
  clock.advanceTo(clock.now() + 11_000);
  // Source 2 threw mid-write: attempted, not finished, and it will be retried.
  tracker.advance("claude", 0, 0, false);

  assert.ok((lines.at(-1) ?? "").includes("1/3 source file(s)"), lines.at(-1));

  // The resume re-scans and still finds 2 pending — the thrower plus source 3.
  tracker.beginPass("claude", 2);
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 0, 0, true);
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 0, 0, true);

  assert.ok(
    (lines.at(-1) ?? "").includes("3/3 source file(s)"),
    `the 3-source population must stay a 3-source denominator: ${lines.at(-1)}`
  );
  assert.deepEqual(tracker.snapshot().byHarness, [
    { harness: "claude", total: 3, processed: 3 },
  ]);
});

test("the averages divide by the attempts since the resume, and say so", () => {
  const { tracker, clock, lines } = createTracker();

  tracker.beginPass("claude", 4);
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 1000, 2000);
  // The manager's parse/import accumulators reset with the pass, so after a
  // resume the averages must divide by the per-resume count, not the cumulative
  // one — otherwise a long backfill reports ever-shrinking per-source costs.
  tracker.beginPass("claude", 3);
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 500, 700);

  assert.ok(
    (lines.at(-1) ?? "").includes("parse 500ms, import 700ms"),
    lines.at(-1)
  );
  // bot review (ISS-5028): the fraction counts sources FINISHED and the averages
  // count ATTEMPTS since the resume, so the line must not label both "per
  // source". A retried source costs real time and belongs in the divisor.
  clock.advanceTo(clock.now() + 11_000);
  tracker.advance("claude", 900, 1500, false);
  assert.ok(
    (lines.at(-1) ?? "").includes(
      "2/4 source file(s) (avg over 2 attempt(s) since resume: parse 450ms, import 750ms)"
    ),
    lines.at(-1)
  );
});

test("ISS-5808: abandonPass authorizes a BOUNDED number of in-session re-drives", () => {
  const { tracker, lines } = createTracker();

  // Three consecutive abandonments stay budgeted; the fourth does not, so the
  // watcher stops re-arming a pass against a db-host that keeps dying.
  assert.equal(tracker.abandonPass("codex", "db-host exited (code: 0)"), true);
  assert.equal(tracker.abandonPass("codex", "db-host exited (code: 0)"), true);
  assert.equal(tracker.abandonPass("codex", "db-host exited (code: 0)"), true);
  assert.equal(tracker.abandonPass("codex", "db-host exited (code: 0)"), false);
  assert.ok(
    lines.some((line) => line.includes("re-drive budget exhausted")),
    `exhaustion must be legible in the log, not silent; saw ${JSON.stringify(lines)}`
  );

  // A settled pass is evidence the harness recovered, so the budget resets —
  // only an UNBROKEN run of abandonments may exhaust it.
  tracker.settlePass("codex");
  assert.equal(tracker.abandonPass("codex", "db-host exited (code: 0)"), true);

  // Budgets are per harness.
  assert.equal(tracker.abandonPass("claude", "db-host exited (code: 0)"), true);
});
