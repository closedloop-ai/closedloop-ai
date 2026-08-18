import { describe, expect, it } from "vitest";
import type {
  CloudReadLaneReadiness,
  CloudReadReadinessSnapshot,
} from "../../../shared/cloud-read-readiness-contract";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../shared/sync-burndown-contract";
import {
  CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS,
  CloudReadCutoverBlocker,
  CloudReadCutoverLatch,
  DesktopAppCoreMode,
  resolveCloudReadCutover,
  resolveDesktopAppCoreMode,
} from "../desktop-app-core-mode";

const SAMPLED_AT = "2026-08-07T12:00:00.000Z";

function lane(
  overrides: Partial<CloudReadLaneReadiness> = {}
): CloudReadLaneReadiness {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    unmeasuredRows: 0,
    ...overrides,
  };
}

function readiness(
  overrides: Partial<CloudReadReadinessSnapshot> = {}
): CloudReadReadinessSnapshot {
  return {
    sampledAtIso: SAMPLED_AT,
    importComplete: true,
    lanes: [lane()],
    ...overrides,
  };
}

/** The steady state after everything has genuinely drained. */
function drainedInput() {
  return {
    status: DesktopAuthStatus.Authenticated,
    isOnline: true,
    readiness: readiness(),
    latch: CloudReadCutoverLatch.None,
    unchangedForMs: 0,
  };
}

describe("resolveDesktopAppCoreMode", () => {
  // PRD-522 R1.3 mutation-sanity guard: an authenticated + online desktop whose
  // backlog has drained must resolve to the cloud (http) read. Forcing
  // scope:"local" here (regressing the PLN-1138 cutover) would flip this to
  // Local and fail the assertion.
  it("reads cloud when authenticated, online, and fully drained", () => {
    expect(resolveDesktopAppCoreMode(drainedInput())).toBe(
      DesktopAppCoreMode.Cloud
    );
  });

  it("degrades an authenticated session to local while offline (D3 / AC-3.3)", () => {
    expect(
      resolveDesktopAppCoreMode({ ...drainedInput(), isOnline: false })
    ).toBe(DesktopAppCoreMode.Local);
  });

  it("stays local for every non-authenticated status, online or not", () => {
    const nonAuthenticated = Object.values(DesktopAuthStatus).filter(
      (status) => status !== DesktopAuthStatus.Authenticated
    );
    // Guards the enum itself: if a status is added, it must be considered here
    // rather than silently defaulting one way.
    expect(nonAuthenticated).toEqual([
      DesktopAuthStatus.Loading,
      DesktopAuthStatus.SignedOut,
      DesktopAuthStatus.OpeningBrowser,
      DesktopAuthStatus.AwaitingRedirect,
      DesktopAuthStatus.Exchanging,
      DesktopAuthStatus.RefreshFailed,
    ]);

    for (const status of nonAuthenticated) {
      for (const isOnline of [true, false]) {
        expect(
          resolveDesktopAppCoreMode({ ...drainedInput(), status, isOnline }),
          `${status} (online=${isOnline}) must stay local`
        ).toBe(DesktopAppCoreMode.Local);
      }
    }
  });
});

describe("resolveCloudReadCutover — the ISS-5477 regression", () => {
  it("keeps an authenticated user on local reads while the upload backlog is still draining", () => {
    // The reported bug, exactly: a populated machine signs in with the sync
    // outbox full. Before this gate the mode flipped to Cloud here, the cloud
    // held nothing, and the user's history appeared to have been deleted.
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 3401 }),
          lane({ lane: SyncLaneId.TranscriptArchive }),
        ],
      }),
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.SyncDraining);
    expect(decision.failedOpen).toBe(false);
    expect(decision.itemsRemaining).toBe(3401);
  });

  it("keeps local reads until the initial parse/import backlog completes", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({ importComplete: false }),
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.ImportPending);
  });

  it("treats a burn-down that has never sampled as unknown, not drained", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({ sampledAtIso: null }),
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.ReadinessUnknown);
  });

  it("treats an unresolved readiness read as unknown, not drained", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: null,
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.ReadinessUnknown);
  });

  it("does NOT cut over on drained_with_dead_letters — gave up is not caught up", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            itemsRemaining: 0,
            deadLetteredCount: 7,
            unmeasuredRows: 0,
          }),
        ],
      }),
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.SyncGaveUp);
    expect(decision.deadLetteredCount).toBe(7);
  });

  it("does NOT cut over on remaining_unknown — an unmeasured remainder is not zero", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({
            state: SyncLaneDrainState.RemainingUnknown,
            itemsRemaining: null,
          }),
        ],
      }),
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.SyncNotEstablished);
    expect(decision.itemsRemaining).toBeNull();
  });

  it("does NOT cut over on a sample that measured no lanes at all, and owes an UNKNOWN remainder rather than zero", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({ lanes: [] }),
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.SyncNotEstablished);
    // `sync_not_established` is one of the two blockers DashboardCutoverStatus
    // renders on, and it prints the remainder verbatim. Summing zero lanes to
    // `0` would put "Uploading history · 0 to go" on screen for a machine that
    // never counted anything — the chip's own "an unmeasured remainder is not a
    // zero" rule, pinned here rather than left to its comment.
    expect(decision.itemsRemaining).toBeNull();
  });

  it("holds for a stopped lane that still has work, but not for one with an empty queue", () => {
    const stoppedWithWork = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({
            lane: SyncLaneId.TraceComments,
            state: SyncLaneDrainState.IdleNotRunning,
            itemsRemaining: 4,
          }),
        ],
      }),
    });
    expect(stoppedWithWork.mode).toBe(DesktopAppCoreMode.Local);
    expect(stoppedWithWork.blocker).toBe(
      CloudReadCutoverBlocker.SyncNotEstablished
    );

    // A lane whose gate is shut and whose queue is measurably empty owes the
    // cloud nothing. Blocking on it would wait forever (transcript upload turned
    // off, a closed org policy) for work that does not exist.
    const stoppedAndEmpty = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane(),
          lane({
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.IdleNotRunning,
            itemsRemaining: 0,
          }),
        ],
      }),
    });
    expect(stoppedAndEmpty.mode).toBe(DesktopAppCoreMode.Cloud);
    expect(stoppedAndEmpty.blocker).toBeNull();
  });

  // ISS-5477 regression pin, for the DEFAULT signed-in configuration. At the
  // default Metadata sync level `transcriptSyncEnabled` is false
  // (`shared/contracts.ts`), so the transcript lane never runs this launch and
  // the burn-down reporter — which decides `started` by OBSERVATION
  // (`everRunningLanes`, `sync-burndown-reporter.ts`) — classifies it
  // `never_started`, NOT `idle_not_running`. That is the state a lane switched
  // off by policy actually arrives in, and it is distinct from the
  // `idle_not_running` case pinned above.
  //
  // A lane that policy disabled owes the cloud nothing, so it must be EXCLUDED
  // from the drain requirement rather than waited on. Were it instead treated as
  // outstanding work, every default user would sit on Local until the bounded
  // fail-open elapsed — hiding cloud-only and team sessions on each launch — so
  // this pins the cutover at `unchangedForMs: 0`, before any fail-open could
  // mask a regression.
  it("reaches the cloud read at the default sync level, without waiting on a policy-disabled lane", () => {
    const defaultMetadataLevel = resolveCloudReadCutover({
      ...drainedInput(),
      unchangedForMs: 0,
      readiness: readiness({
        lanes: [
          lane(),
          lane({
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.NeverStarted,
            itemsRemaining: 0,
          }),
        ],
      }),
    });

    expect(defaultMetadataLevel.mode).toBe(DesktopAppCoreMode.Cloud);
    expect(defaultMetadataLevel.blocker).toBeNull();

    // The exclusion is scoped to lanes that owe nothing: the same disabled lane
    // holding stranded rows is real local work and must still hold the reader.
    const disabledButStranded = resolveCloudReadCutover({
      ...drainedInput(),
      unchangedForMs: 0,
      readiness: readiness({
        lanes: [
          lane(),
          lane({
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.NeverStarted,
            itemsRemaining: 7,
          }),
        ],
      }),
    });

    expect(disabledButStranded.mode).toBe(DesktopAppCoreMode.Local);
    expect(disabledButStranded.blocker).toBe(
      CloudReadCutoverBlocker.SyncNotEstablished
    );
  });

  it("reports an actively draining lane ahead of one that gave up", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 2,
            unmeasuredRows: 0,
          }),
          lane({
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 9,
          }),
        ],
      }),
    });

    expect(decision.blocker).toBe(CloudReadCutoverBlocker.SyncDraining);
  });
});

describe("resolveCloudReadCutover — the bounded fail-open", () => {
  it("stays local while the stall clock is short of the bound", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 5 }),
        ],
      }),
      unchangedForMs: CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS - 1,
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.failedOpen).toBe(false);
  });

  it("lets a wedged lane through at the bound, and says the view may be incomplete", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            itemsRemaining: 0,
            deadLetteredCount: 12,
            unmeasuredRows: 0,
          }),
        ],
      }),
      unchangedForMs: CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS,
    });

    // Trading "data disappears" for "stuck on Local forever" is not a fix, so
    // the reader is let through — but the blocker is retained so the badge can
    // say the cloud view is missing what the lane gave up on.
    expect(decision.mode).toBe(DesktopAppCoreMode.Cloud);
    expect(decision.failedOpen).toBe(true);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.SyncGaveUp);
    expect(decision.latch).toBe(CloudReadCutoverLatch.FailedOpen);
  });

  it("never fails open before any reading has been taken", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: null,
      unchangedForMs: null,
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.failedOpen).toBe(false);
  });

  it("clears the failed-open warning once the backlog genuinely drains", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      latch: CloudReadCutoverLatch.FailedOpen,
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Cloud);
    expect(decision.failedOpen).toBe(false);
    expect(decision.latch).toBe(CloudReadCutoverLatch.Drained);
  });
});

describe("resolveCloudReadCutover — hysteresis", () => {
  it("does not bounce back to local when new work appears after a cutover", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 2 }),
        ],
      }),
      latch: CloudReadCutoverLatch.Drained,
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Cloud);
    expect(decision.latch).toBe(CloudReadCutoverLatch.Drained);
    // The blocker is retained so the badge can say newer local work has not
    // arrived yet — a staleness, not a disappearance.
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.SyncDraining);
    expect(decision.failedOpen).toBe(false);
  });

  it("keeps the latch across an offline blip so reconnecting returns straight to cloud", () => {
    const offline = resolveCloudReadCutover({
      ...drainedInput(),
      isOnline: false,
      latch: CloudReadCutoverLatch.Drained,
    });
    expect(offline.mode).toBe(DesktopAppCoreMode.Local);
    expect(offline.blocker).toBe(CloudReadCutoverBlocker.Offline);
    expect(offline.latch).toBe(CloudReadCutoverLatch.Drained);

    const backOnline = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: readiness({
        lanes: [
          lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 1 }),
        ],
      }),
      latch: offline.latch,
    });
    expect(backOnline.mode).toBe(DesktopAppCoreMode.Cloud);
  });

  it("drops the latch when the session ends, so the next user gets the full gate", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      status: DesktopAuthStatus.SignedOut,
      latch: CloudReadCutoverLatch.Drained,
    });

    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    expect(decision.latch).toBe(CloudReadCutoverLatch.None);
    expect(decision.blocker).toBe(CloudReadCutoverBlocker.NotAuthenticated);
  });
});

/**
 * ISS-5714: `cloudHoldsHistory` is the BACKLOG axis of the same decision, with
 * connectivity deliberately excluded, and it is what the desktop Branches
 * surface selects its read store from. It agrees with `mode` everywhere except
 * the two paths that return early on connectivity, and those are exactly the
 * paths the cross-surface integration test cannot reach — so every branch is
 * pinned here, in the pure function, one case each.
 */
describe("resolveCloudReadCutover — cloudHoldsHistory (ISS-5714)", () => {
  const drainingReadiness = readiness({
    lanes: [lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 12 })],
  });

  it("is false when nobody is signed in — there is no workspace copy to speak of", () => {
    expect(
      resolveCloudReadCutover({
        ...drainedInput(),
        status: DesktopAuthStatus.SignedOut,
      }).cloudHoldsHistory
    ).toBe(false);
  });

  it("is false while the measured backlog is still draining", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: drainingReadiness,
    });
    expect(decision.mode).toBe(DesktopAppCoreMode.Local);
    // Both surfaces go local together — the parity invariant this ticket bought.
    expect(decision.cloudHoldsHistory).toBe(false);
  });

  it("is true once the backlog has genuinely drained", () => {
    expect(resolveCloudReadCutover(drainedInput()).cloudHoldsHistory).toBe(
      true
    );
  });

  it("is true under the hysteresis latch, even with new local work outstanding", () => {
    expect(
      resolveCloudReadCutover({
        ...drainedInput(),
        readiness: drainingReadiness,
        latch: CloudReadCutoverLatch.Drained,
      }).cloudHoldsHistory
    ).toBe(true);
  });

  it("is true when the bounded stall fail-open lets the reader through", () => {
    const decision = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: drainingReadiness,
      unchangedForMs: CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS,
    });
    expect(decision.failedOpen).toBe(true);
    expect(decision.cloudHoldsHistory).toBe(true);
  });

  it("reports the carried latch offline, because the backlog cannot be re-measured", () => {
    const neverReached = resolveCloudReadCutover({
      ...drainedInput(),
      isOnline: false,
    });
    expect(neverReached.mode).toBe(DesktopAppCoreMode.Local);
    expect(neverReached.blocker).toBe(CloudReadCutoverBlocker.Offline);
    // Never cut over, and cannot check now: claiming the cloud has the corpus
    // would park Branches on a paused, empty cloud read.
    expect(neverReached.cloudHoldsHistory).toBe(false);

    for (const latch of [
      CloudReadCutoverLatch.Drained,
      CloudReadCutoverLatch.FailedOpen,
    ]) {
      const alreadyReached = resolveCloudReadCutover({
        ...drainedInput(),
        isOnline: false,
        latch,
      });
      // The corpus is up there either way; losing the network does not unsend it.
      expect(alreadyReached.cloudHoldsHistory).toBe(true);
    }
  });

  it("fails open for a preload with no readiness channel, but only while online", () => {
    const online = resolveCloudReadCutover({
      ...drainedInput(),
      readiness: null,
      readinessUnavailable: true,
    });
    expect(online.mode).toBe(DesktopAppCoreMode.Cloud);
    expect(online.cloudHoldsHistory).toBe(true);
    // The cutover this branch performs is recorded, so a later offline pass can
    // tell "already on the cloud, cache warm" from "never got there".
    expect(online.latch).toBe(CloudReadCutoverLatch.FailedOpen);

    const offlineAfterCompatCutover = resolveCloudReadCutover({
      ...drainedInput(),
      isOnline: false,
      readiness: null,
      readinessUnavailable: true,
      latch: online.latch,
    });
    expect(offlineAfterCompatCutover.cloudHoldsHistory).toBe(true);

    const offlineColdStart = resolveCloudReadCutover({
      ...drainedInput(),
      isOnline: false,
      readiness: null,
      readinessUnavailable: true,
    });
    // Never reached the cloud AND cannot reach it now. Failing open here would
    // reproduce the reported symptom through the compatibility path.
    expect(offlineColdStart.mode).toBe(DesktopAppCoreMode.Local);
    expect(offlineColdStart.cloudHoldsHistory).toBe(false);

    const offlineAfterCutover = resolveCloudReadCutover({
      ...drainedInput(),
      isOnline: false,
      readiness: null,
      readinessUnavailable: true,
      latch: CloudReadCutoverLatch.Drained,
    });
    expect(offlineAfterCutover.cloudHoldsHistory).toBe(true);
  });
});
