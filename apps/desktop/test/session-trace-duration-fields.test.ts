import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import {
  baseSessionTraceInput as baseInput,
  traceTimelineRow as timelineRow,
} from "./session-trace-test-utils.js";

/** The "idle" label token that must NOT be baked into the raw waitingUser value. */
const idleLabelToken = /idle/i;

// FEA-4275: the trace collector emits the wall / active / waiting-on-user
// DURATION components as pre-formatted strings. The `waitingUser` component must
// be a CLEAN duration value — the label is applied by the display authority
// (`resolveSessionDurationBreakdown`), never baked into the value. Historically
// the producer baked the word into the value ("41s idle"), which the Duration
// row then re-labeled into the doubled "41s idle idle". These pin the clean
// producer contract so the doubling cannot regress at the source.

test("FEA-4275: waitingUser is a clean idle duration with no baked-in 'idle' label", () => {
  // AssistantMessage (agent) then UserMessage (human) 5m later → the agent spent
  // that 5m gap waiting on the user, which is the waitingUser bucket.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      timelineRows: [
        timelineRow("2026-06-07T12:02:00.000Z", "AssistantMessage"),
        timelineRow("2026-06-07T12:07:00.000Z", "UserMessage"),
      ],
    })
  );

  assert.equal(fields.waitingUser, "5m");
  // Belt-and-suspenders: the value must not carry the label token at all.
  assert.equal(idleLabelToken.test(fields.waitingUser ?? ""), false);
});

test("FEA-4275: active + idle stay within wall (excluded gaps are the remainder)", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      // ISS-5182: `ended_at` IS max(event.created_at) for a terminal session,
      // so it must equal the last timeline row (12:08), not run past it.
      endedAt: "2026-06-07T12:08:00.000Z",
      timelineRows: [
        // Agent works, then waits on the user — active precedes idle.
        timelineRow("2026-06-07T12:01:00.000Z", "AssistantMessage"),
        timelineRow("2026-06-07T12:03:00.000Z", "AssistantMessage"),
        timelineRow("2026-06-07T12:08:00.000Z", "UserMessage"),
      ],
    })
  );

  // 8m wall (start→last activity); 2m active (12:01→12:03), 5m idle
  // (12:03→12:08). The remaining 1m (session start→first activity) is the
  // explicitly excluded gap — active + idle need not equal wall.
  assert.equal(fields.wallClock, "8m");
  assert.equal(fields.activeAgent, "2m");
  assert.equal(fields.waitingUser, "5m");
});

// ISS-4569: a MEASURED zero and an UNMEASURED value are different facts, and the
// producer is the only layer that still knows which one it holds. Collapsing both
// into `null` hands every consumer a value it cannot tell apart from "unknown",
// so a session that genuinely spent 0s waiting on the person is indistinguishable
// from one nothing was ever measured for — and the two components stop
// reconciling against `wallClock`, which is what FEA-4275 set out to fix. The
// discriminator is whether there were timeline rows to measure over at all.

test("ISS-4569: a measured zero emits '0s', not the unknown null", () => {
  // A single UserMessage at session start — the activity window collapses to
  // a point (0s), so the agent-active and waiting-on-user sums are a genuine,
  // computed zero over real timeline data. `wallClock` already reports that
  // window honestly as "0s"; its two sub-facts must agree with it.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      // ISS-5182: max(event.created_at) is the single 12:00 row, so that is the
      // session's end — which is what collapses the window to a point.
      endedAt: "2026-06-07T12:00:00.000Z",
      timelineRows: [timelineRow("2026-06-07T12:00:00.000Z", "UserMessage")],
    })
  );

  assert.equal(fields.wallClock, "0s");
  assert.equal(fields.activeAgent, "0s");
  assert.equal(fields.waitingUser, "0s");
});

test("ISS-4569: a session that only ever worked reports a measured-zero waitingUser beside a nonzero activeAgent", () => {
  // Two agent turns and no human turn after them: the agent worked a measured 2m
  // and waited on the person for a measured 0s. This is the case the ticket was
  // filed for — the value read as "unknown" when the honest answer is "0s".
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:03:00.000Z",
      timelineRows: [
        timelineRow("2026-06-07T12:01:00.000Z", "AssistantMessage"),
        timelineRow("2026-06-07T12:03:00.000Z", "AssistantMessage"),
      ],
    })
  );

  assert.equal(fields.activeAgent, "2m");
  assert.equal(fields.waitingUser, "0s");
});

test("ISS-4569: no timeline rows leaves the components unmeasured (null), not a fabricated zero", () => {
  // Nothing to measure over: there is no computed zero here, only an absence.
  // `null` is the honest internal representation of "unknown", and it is what the
  // display layer renders as the em dash.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      timelineRows: [],
    })
  );

  assert.equal(fields.activeAgent, null);
  assert.equal(fields.waitingUser, null);
});

test("ISS-4569: a trace whose rows all carry unparseable timestamps is unmeasured, not a measured zero", () => {
  // `createdAt` is a bare string off persisted rows, so a malformed value is
  // reachable here. Every gap computes to NaN and is skipped, leaving sums of 0
  // over rows that measured nothing — presence of a row must not be mistaken for
  // evidence, or this reintroduces the exact conflation the ticket removes.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      timelineRows: [
        timelineRow("not-a-timestamp", "AssistantMessage"),
        timelineRow("", "UserMessage"),
      ],
    })
  );

  assert.equal(fields.activeAgent, null);
  assert.equal(fields.waitingUser, null);
});

test("ISS-4569: a mixed trace still measures over the rows that do parse", () => {
  // One unparseable row among real ones is dropped, not fatal: the surviving
  // 12:01→12:03 agent gap and 12:03→12:08 wait are still measured.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:08:00.000Z",
      timelineRows: [
        timelineRow("2026-06-07T12:01:00.000Z", "AssistantMessage"),
        timelineRow("2026-06-07T12:03:00.000Z", "AssistantMessage"),
        timelineRow("garbage", "AssistantMessage"),
        timelineRow("2026-06-07T12:08:00.000Z", "UserMessage"),
      ],
    })
  );

  assert.equal(fields.activeAgent, "2m");
  assert.equal(fields.waitingUser, "5m");
});

test("ISS-4569: measured-zero and unmeasured components both emit a PRESENT key, so a reimport still clears a stale nonzero value", () => {
  // The cloud patch PRESERVES omitted trace fields, so a recomputed component has
  // to arrive as a present key to overwrite a previously-synced nonzero duration.
  // That holds for the measured zero ("0s") and the unmeasured component (`null`)
  // alike — the FEA-3427 patch semantics survive the ISS-4569 split intact.
  // Asserted separately from the VALUE cases above because presence is the part
  // an omitted-field regression would break while the values still looked right.
  const measuredZero = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:00:00.000Z",
      timelineRows: [timelineRow("2026-06-07T12:00:00.000Z", "UserMessage")],
    })
  );
  assert.ok("activeAgent" in measuredZero);
  assert.ok("waitingUser" in measuredZero);

  const unmeasured = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:10:00.000Z",
      timelineRows: [],
    })
  );
  assert.ok("activeAgent" in unmeasured);
  assert.ok("waitingUser" in unmeasured);
});
