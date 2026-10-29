import assert from "node:assert/strict";
import { test } from "vitest";
import { createAuthSessionLaneKicks } from "../src/main/agent-sync/sync-lane-kicks.js";
import type { TranscriptSyncService } from "../src/main/transcript-sync/transcript-sync-service.js";

// ISS-9418 — the lane wiring extracted out of the grandfathered `app.ts`. These
// pin what the extraction owns: the identity-change door only RE-ARMS a given-up
// lane, a same-account token renewal reaches only the pacing clear, and the
// transcript lane is resolved per call because `app.ts` reconstructs it on a tier
// change. ISS-11449 removed the org-policy re-kick seam along with the policy;
// the transcript sweep it used to kick on sign-in now rides the identity door.

function fakeTranscriptLane(
  onReArm: () => void,
  onSweep: () => void = () => undefined
): TranscriptSyncService {
  return {
    noteLaneRecoverySignal: () => onReArm(),
    sweepOnce: () => {
      onSweep();
      return Promise.resolve();
    },
  } as unknown as TranscriptSyncService;
}

test("the identity-change door re-arms the lane and does NOT kick it", () => {
  const calls: string[] = [];
  const kicks = createAuthSessionLaneKicks({
    agentSessionSync: {
      noteLaneRecoverySignal: () => calls.push("re-arm"),
      noteCredentialsRefreshed: () => calls.push("credentials"),
    },
    getTranscriptSync: () => null,
  });

  kicks.noteLaneRecoverySignal();

  assert.deepEqual(calls, ["re-arm"]);

  // ISS-8610: and the credential-renewal door is a DIFFERENT one — it reaches
  // only the pacing clear, never the re-arm, so a token refresh cannot spend the
  // one attempt a give-up's widening window is rationing.
  kicks.noteCredentialsRefreshed();

  assert.deepEqual(calls, ["re-arm", "credentials"]);
});

// ISS-9884 (PLN-1986 §5): the transcript lane's give-up takes the same doors.

test("ISS-9884/ISS-11449: the identity-change door re-arms then sweeps the transcript lane, and a token renewal does neither", () => {
  const calls: string[] = [];
  const kicks = createAuthSessionLaneKicks({
    agentSessionSync: {
      noteLaneRecoverySignal: () => calls.push("session re-arm"),
      noteCredentialsRefreshed: () => calls.push("session credentials"),
    },
    getTranscriptSync: () =>
      fakeTranscriptLane(
        () => calls.push("transcript re-arm"),
        () => calls.push("transcript sweep")
      ),
  });

  kicks.noteLaneRecoverySignal();

  assert.deepEqual(calls, [
    "session re-arm",
    "transcript re-arm",
    "transcript sweep",
  ]);

  // A same-account renewal is frequent, so re-arming a give-up on it would make
  // the 24h ceiling a function of the refresh cadence.
  kicks.noteCredentialsRefreshed();

  assert.deepEqual(calls, [
    "session re-arm",
    "transcript re-arm",
    "transcript sweep",
    "session credentials",
  ]);
});

test("ISS-9884: the transcript lane is resolved per call, never a captured one", () => {
  // What `reconcileTranscriptSyncLane` does on a tier change: the old lane is
  // replaced, and a reference captured at wiring time would keep re-arming it.
  const reArmed: string[] = [];
  let lane: TranscriptSyncService | null = fakeTranscriptLane(() =>
    reArmed.push("first")
  );
  const kicks = createAuthSessionLaneKicks({
    agentSessionSync: {
      noteLaneRecoverySignal: () => undefined,
      noteCredentialsRefreshed: () => undefined,
    },
    getTranscriptSync: () => lane,
  });

  kicks.noteLaneRecoverySignal();
  lane = fakeTranscriptLane(() => reArmed.push("second"));
  kicks.noteLaneRecoverySignal();

  assert.deepEqual(reArmed, ["first", "second"]);
});
