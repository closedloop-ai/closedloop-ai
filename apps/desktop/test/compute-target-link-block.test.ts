import assert from "node:assert/strict";
import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { describe, it } from "vitest";
import { createComputeTargetLinkBlockTracker } from "../src/main/agent-sync/compute-target-link-block.js";
import type { SyncLaneBatchEvent } from "../src/main/agent-sync/sync-lane-cloud-health.js";
import { DesktopSyncBatchOutcome } from "../src/main/telemetry/app-otel-runtime.js";

const TARGET = "target-1";

function failure(
  reason: SyncReason,
  lane: SyncLane = SyncLane.InvocationParts
): SyncLaneBatchEvent {
  return {
    lane,
    outcome: DesktopSyncBatchOutcome.Failure,
    reason,
  };
}

function success(
  lane: SyncLane = SyncLane.InvocationParts
): SyncLaneBatchEvent {
  return {
    lane,
    outcome: DesktopSyncBatchOutcome.Success,
  };
}

describe("ISS-11426 compute-target link block", () => {
  it("starts unblocked, so nothing is claimed before a refusal is seen", () => {
    assert.equal(createComputeTargetLinkBlockTracker().read(), null);
  });

  it("latches an ownership refusal with the target the cloud refused", () => {
    const tracker = createComputeTargetLinkBlockTracker(() =>
      Date.parse("2026-09-28T17:00:00.000Z")
    );

    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);

    assert.deepEqual(tracker.read(), {
      refusedComputeTargetId: TARGET,
      refusedBatchCount: 1,
      firstRefusedAt: "2026-09-28T17:00:00.000Z",
    });
  });

  it("counts further refusals of the same target without restarting the block", () => {
    let nowMs = Date.parse("2026-09-28T17:00:00.000Z");
    const tracker = createComputeTargetLinkBlockTracker(() => nowMs);

    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);
    nowMs += 60_000;
    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);

    assert.equal(tracker.read()?.refusedBatchCount, 2);
    // The FIRST refusal is what dates the block; re-stamping it would make a
    // two-day-old block read as a fresh one on every retry.
    assert.equal(tracker.read()?.firstRefusedAt, "2026-09-28T17:00:00.000Z");
  });

  it("NEVER latches an org-policy denial, which relinking cannot fix", () => {
    const tracker = createComputeTargetLinkBlockTracker();

    tracker.observe(failure(SyncReason.FeatureDisabled), TARGET);

    assert.equal(tracker.read(), null);
  });

  it("clears the block when the same target is accepted again", () => {
    const tracker = createComputeTargetLinkBlockTracker();
    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);

    tracker.observe(success(), TARGET);

    assert.equal(tracker.read(), null);
  });

  it("restarts the block for a different target rather than crediting the old one", () => {
    let nowMs = Date.parse("2026-09-28T17:00:00.000Z");
    const tracker = createComputeTargetLinkBlockTracker(() => nowMs);
    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);
    nowMs += 60_000;

    tracker.observe(failure(SyncReason.TargetNotOwned), "target-2");

    assert.deepEqual(tracker.read(), {
      refusedComputeTargetId: "target-2",
      refusedBatchCount: 1,
      firstRefusedAt: "2026-09-28T17:01:00.000Z",
    });
  });

  it("clears on a success under a DIFFERENT target, which is what a relink produces", () => {
    // The remedy this block exists to prompt mints a new target, so a clear
    // keyed on the refused id would leave the block unclearable for the life of
    // the process and keep telling a relinked user they have not relinked.
    const tracker = createComputeTargetLinkBlockTracker();
    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);

    tracker.observe(success(), "target-2");

    assert.equal(tracker.read(), null);
  });

  it("SURVIVES a failure for a different reason, which says nothing about ownership", () => {
    // A 429 between two ownership refusals must not drop the alert and its
    // action, nor restart the block's age and count on the next refusal.
    let nowMs = Date.parse("2026-09-28T17:00:00.000Z");
    const tracker = createComputeTargetLinkBlockTracker(() => nowMs);
    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);
    nowMs += 60_000;

    tracker.observe(failure(SyncReason.RateLimited), TARGET);
    tracker.observe(failure(SyncReason.TransportError), TARGET);
    tracker.observe(failure(SyncReason.Unauthenticated), TARGET);

    assert.deepEqual(tracker.read(), {
      refusedComputeTargetId: TARGET,
      refusedBatchCount: 1,
      firstRefusedAt: "2026-09-28T17:00:00.000Z",
    });
  });

  it("clears a block latched under an UNNAMED target once a batch is accepted", () => {
    // The lane can be refused before it can name the target it presented — the
    // strict-online id is null while the socket is down. A block latched there
    // must still clear.
    const tracker = createComputeTargetLinkBlockTracker();
    tracker.observe(failure(SyncReason.TargetNotOwned), null);
    assert.equal(tracker.read()?.refusedComputeTargetId, null);

    tracker.observe(success(), TARGET);

    assert.equal(tracker.read(), null);
  });

  it("latches a session-metadata refusal, the lane a device with no invocation backlog is refused on", () => {
    // whitlockk: without this tee a machine whose ONLY refused lane is session
    // metadata sits in exactly the stuck state this ticket is about and no
    // surface says so.
    const tracker = createComputeTargetLinkBlockTracker(() =>
      Date.parse("2026-09-28T17:00:00.000Z")
    );

    tracker.observe(
      failure(SyncReason.TargetNotOwned, SyncLane.SessionMetadata),
      TARGET
    );

    assert.deepEqual(tracker.read(), {
      refusedComputeTargetId: TARGET,
      refusedBatchCount: 1,
      firstRefusedAt: "2026-09-28T17:00:00.000Z",
    });
  });

  it("NEVER latches a trace-comment refusal, whose 403 is uncoded and not about ownership", () => {
    // tamsinb: that lane answers a bare 403 for the org session-sync policy and
    // for editing somebody else's comment, and the desktop folds both to
    // `target_not_owned` on status alone. Offering the relink for either sends
    // the user at an action that cannot help.
    const tracker = createComputeTargetLinkBlockTracker();

    tracker.observe(
      failure(SyncReason.TargetNotOwned, SyncLane.TraceComments),
      TARGET
    );

    assert.equal(tracker.read(), null);
  });

  it("NEVER lets a trace-comment success clear a block another lane is still hitting", () => {
    // whitlockk / codex: a BRANCH-targeted trace comment carries no compute target
    // at all, so its acceptance proves nothing about the identity this machine
    // presents. Clearing on it made the alert flicker on a 1s poll and restart
    // the block's age and count on the next refusal.
    const tracker = createComputeTargetLinkBlockTracker(() =>
      Date.parse("2026-09-28T17:00:00.000Z")
    );
    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);

    tracker.observe(success(SyncLane.TraceComments), TARGET);

    assert.deepEqual(tracker.read(), {
      refusedComputeTargetId: TARGET,
      refusedBatchCount: 1,
      firstRefusedAt: "2026-09-28T17:00:00.000Z",
    });
  });

  it("clears on a component-inventory success, whose route DOES prove ownership", () => {
    // Acceptance-only: that route runs the owner-scoped lookup, so its success
    // is evidence the identity is taken even though its 403 is still uncoded.
    const tracker = createComputeTargetLinkBlockTracker();
    tracker.observe(failure(SyncReason.TargetNotOwned), TARGET);

    tracker.observe(success(SyncLane.ComponentInventory), TARGET);

    assert.equal(tracker.read(), null);
  });

  it("NEVER latches a component-inventory refusal, whose 403 cannot be told from a policy denial", () => {
    const tracker = createComputeTargetLinkBlockTracker();

    tracker.observe(
      failure(SyncReason.TargetNotOwned, SyncLane.ComponentInventory),
      TARGET
    );

    assert.equal(tracker.read(), null);
  });
});
