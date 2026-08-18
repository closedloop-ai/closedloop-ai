/**
 * @file agent-session-hydration-absence.test.ts
 * @description ISS-6031: the pure decision behind the empty-hydration branch.
 *
 * The service-level suites drive one id at a time, because that is what the
 * production batch size is today (`DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST
 * = 1`). That leaves the MIXED partition — one id genuinely gone, a sibling
 * merely unreadable in the same batch — exercised nowhere, even though raising
 * the batch ceiling makes it immediately reachable and an inverted filter there
 * would dispose of exactly the rows this ticket exists to protect.
 *
 * These are the branches where getting it wrong destroys data, so they are
 * pinned directly rather than through the harness.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  decideHydrationAbsence,
  HydrationAbsenceVerdict,
  probeSessionPresence,
} from "../src/main/agent-sync/agent-session-hydration-absence.js";

test("ISS-6031: a mixed batch disposes of ONLY the proven-absent ids and retries the rest", () => {
  const decision = decideHydrationAbsence(["gone", "present", "also-gone"], {
    ok: true,
    presentIds: ["present"],
  });

  assert.equal(decision.verdict, HydrationAbsenceVerdict.StillPresent);
  assert.deepEqual(decision.disposableIds, ["gone", "also-gone"]);
  assert.deepEqual(decision.retryIds, ["present"]);
  // Total and disjoint: an id that fell out of both arrays would be silently
  // lost, which is the failure class this whole change is about.
  assert.deepEqual([...decision.disposableIds, ...decision.retryIds].sort(), [
    "also-gone",
    "gone",
    "present",
  ]);
});

test("ISS-6031: an all-absent probe is the only thing that makes ids disposable", () => {
  const decision = decideHydrationAbsence(["a", "b"], {
    ok: true,
    presentIds: [],
  });

  assert.equal(decision.verdict, HydrationAbsenceVerdict.ConfirmedAbsent);
  assert.deepEqual(decision.disposableIds, ["a", "b"]);
  assert.deepEqual(decision.retryIds, []);
  assert.ok(
    !decision.observation.includes("deleted"),
    "the observation reports what was seen, never a cause"
  );
});

test("ISS-6031: an unverified probe disposes of NOTHING, whatever else is true", () => {
  const decision = decideHydrationAbsence(["a", "b"], {
    ok: false,
    failure: "reader exploded",
  });

  assert.equal(decision.verdict, HydrationAbsenceVerdict.Unverified);
  assert.deepEqual(decision.disposableIds, []);
  assert.deepEqual(decision.retryIds, ["a", "b"]);
  assert.ok(
    decision.observation.includes("reader exploded"),
    "the failure that blocked the probe is carried into the log, not swallowed"
  );
});

test("ISS-6031: a probe that THROWS is unverified — never an empty present set", async () => {
  const probe = await probeSessionPresence(() => {
    throw new Error("libsql read failed");
  });

  assert.equal(probe.ok, false);
  assert.equal(
    probe.ok === false && probe.failure,
    "libsql read failed",
    "a thrown probe reports the throw, not silence"
  );
  // The distinction that matters: `ok: false` must never be reachable as
  // `{ ok: true, presentIds: [] }`, which downstream reads as "all absent".
  assert.deepEqual(
    decideHydrationAbsence(["a"], probe).disposableIds,
    [],
    "a throw can never make an id disposable"
  );
});

test("ISS-6031: a rejected async probe is unverified too", async () => {
  const probe = await probeSessionPresence(() =>
    Promise.reject(new Error("db-host op rejected"))
  );

  assert.equal(probe.ok, false);
  assert.deepEqual(decideHydrationAbsence(["a"], probe).retryIds, ["a"]);
});

test("ISS-6031: a source with no probe is unverified, but a real EMPTY answer is not", async () => {
  const absent = await probeSessionPresence(() => undefined);
  assert.equal(absent.ok, false, "no probe means nothing was established");

  // The sentinel must not swallow a legitimate zero-result: a probe that ran and
  // found nothing IS a confirmed absence, and must stay actionable.
  const empty = await probeSessionPresence(() => []);
  assert.equal(empty.ok, true);
  assert.deepEqual(
    decideHydrationAbsence(["a"], empty).disposableIds,
    ["a"],
    "a probe that ran and found nothing still confirms the absence"
  );
});
