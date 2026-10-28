/**
 * @file agent-component-drained-cursor-recovery.ts
 * @description ISS-4542: the component lane's DRAINED-CURSOR recovery step.
 *
 * The live cursor is drained — nothing newer or incremental is pending — so the
 * dead-lettered rows are re-attempted here, which is what stops a poison backlog item
 * starving live data. Extracted from `agent-session-sync-component-lane.ts` when that
 * file crossed the 1,000-line ceiling: this is one whole responsibility (re-drive the
 * abandoned rows, charge the environmental clock for the row loads and sends nobody
 * else charges for, and persist the snapshot that only this path can dirty), and it
 * reaches the lane only through the collaborators below.
 *
 * The bounded step itself still lives in `agent-component-sync-dead-letter.ts`; this
 * module owns the lane-side wiring around it.
 */

import { randomUUID } from "node:crypto";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import type { TransitionLogger } from "../diagnostics/component-sync-diagnostics.js";
import type { LaneEnvironmentalDeferGate } from "../sync/lane-environmental-defer.js";
import type { ComponentLaneGiveUp } from "./agent-component-lane-give-up.js";
import type {
  ComponentSyncDeadLetterTracker,
  ComponentSyncSendResult,
} from "./agent-component-sync-dead-letter.js";
import {
  ComponentSyncSendOutcome,
  recoverComponentDeadLetters,
} from "./agent-component-sync-dead-letter.js";
import type {
  AgentComponentSyncLaneOptions,
  ComponentDeadLetterRecoveryInput,
} from "./agent-component-sync-lane-contract.js";
import {
  AGENT_COMPONENT_BATCH_SIZE,
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
} from "./agent-session-sync-source.js";
import { componentRecoveryBatchEvent } from "./sync-lane-cloud-health.js";

/** The lane state this step reads and mutates, injected rather than reached into. */
export type ComponentDrainedCursorRecoveryDeps = {
  deadLetters: ComponentSyncDeadLetterTracker;
  giveUpStamp: ComponentLaneGiveUp;
  environmentalDefer: LaneEnvironmentalDeferGate;
  diag: TransitionLogger;
  onBatchTelemetry: AgentComponentSyncLaneOptions["onComponentSyncBatchTelemetry"];
  /** ISS-8593: recovery advances no cursor, so this is the only way its snapshot
   * reaches disk. */
  persistDeadLetterSnapshot: (sourceKey: string) => void;
};

/** The lane's diagnostic tag, so the extracted step logs where it always did. */
const TAG = "agent-session-sync";

/**
 * Re-attempt the dead-lettered rows on a drained cursor. If a re-attempt runs (making
 * forward progress or re-failing one bounded step), the caller skips the idle
 * "nothing to upload" transition so recovery owns that tick's diagnostic.
 */
export async function recoverDeadLettersOnDrainedCursor(
  deps: ComponentDrainedCursorRecoveryDeps,
  input: ComponentDeadLetterRecoveryInput
): Promise<void> {
  const {
    sendComponents,
    loadComponentRows,
    isCurrent,
    sinceTs,
    sinceId,
    sourceKey,
  } = input;
  // `isCurrent` is optional on the recovery input; absent means "no identity
  // guard wired", which `recoverComponentDeadLetters` itself reads as current.
  const stillCurrent = () => !isCurrent || isCurrent();
  // ISS-8593 (whitlockk review): the dead-letter snapshot reaches disk ONLY as a
  // passenger on a keyset advance, and this path has no advance — the cursor is
  // drained, which is the precondition for running recovery at all. So every
  // change recovery makes lived in memory only: a success DELETED the entry
  // while the durable row still listed the id (a restart re-seeded it and
  // re-sent a component that had already made it), and a failure advanced
  // `attempts` while the durable row still held the pre-recovery count (a
  // restart resumed the OLD backoff and re-attempted too soon) — which is the
  // exact backoff-position durability this change exists to provide.
  const revisionBeforeRecovery = deps.deadLetters.revision;
  const recovered = await recoverComponentDeadLetters({
    tracker: deps.deadLetters,
    batchLimit: AGENT_COMPONENT_BATCH_SIZE,
    loadComponentRows: async (ids) => {
      try {
        return await loadComponentRows(ids);
      } catch (error) {
        // ISS-11389: a failed row load leaves the ids due, so without this
        // charge the next drained tick re-reads them every 5s forever.
        deps.giveUpStamp.noteLocalReadFailed(Date.now(), stillCurrent);
        throw error;
      }
    },
    sendComponents: async (components) => {
      let result: ComponentSyncSendResult;
      try {
        result = await sendComponents({
          schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
          batchId: randomUUID(),
          syncMode: AgentSessionSyncMode.Incremental,
          componentCount: components.length,
          components,
        });
      } catch (error) {
        // ISS-8615 (whitlockk / marisolashgrove review): `recoverComponentDeadLetters`
        // catches this rejection itself (its `dead-letter-send-threw` arm) and
        // keeps the ids due, so the wrapper below never sees it — the charge
        // has to happen BEFORE it is swallowed, or a caught-up install with
        // recovery-only work retries a thrown transport failure every 5s
        // forever. Same defence-in-depth as the main send path's catch.
        if (stillCurrent()) {
          deps.giveUpStamp.noteEnvironmentalOutcome(
            deps.environmentalDefer.noteEnvironmentalFailure(Date.now()),
            SyncReason.TransportError
          );
        }
        throw error;
      }
      // ISS-6338: recovery sends never reach `applySendOutcome`, and on a
      // drained install they are the ONLY sends this lane makes.
      //
      // ISS-8615: which is exactly why the environmental clock has to be
      // charged HERE too. Gating the tick holds a run that is already open,
      // but only a charge OPENS one — so without this, a drained install (the
      // steady state once the backfill lands) would keep hammering an outage
      // on the 5s tick, which is the behaviour this gate exists to end.
      //
      // Behind `stillCurrent()` for the reason the main path's charge is: this
      // resolves before `recoverComponentDeadLetters` re-checks freshness, so
      // an unguarded charge would land a superseded run's verdict on the new
      // identity's gate (invariant 2).
      if (stillCurrent()) {
        if (result.outcome === ComponentSyncSendOutcome.LaneFailure) {
          // ISS-9698: the server's `Retry-After`, where it sent one, is a
          // FLOOR under the staged rung — never a ceiling on it.
          deps.giveUpStamp.noteEnvironmentalOutcome(
            deps.environmentalDefer.noteEnvironmentalFailure(
              Date.now(),
              result.retryAfterMs
            ),
            result.reason ?? SyncReason.TransportError
          );
        } else {
          deps.environmentalDefer.noteLaneAnswered();
        }
      }
      deps.onBatchTelemetry?.(
        componentRecoveryBatchEvent(result.outcome, result.reason)
      );
      return result;
    },
    diag: deps.diag,
    logTag: TAG,
    // ISS-4542 (whitlockk review): supersede late recovery writes when the identity
    // changed mid-await, so the outcome never lands on the new tracker.
    isCurrent,
  });
  // Gated on the identity holding for the same reason every other post-await
  // mutation in this lane is: a `resetSourceState()` during the recovery awaits
  // means these dead letters belong to the previous target, and `clear()` is
  // itself a revision bump.
  if (deps.deadLetters.revision !== revisionBeforeRecovery && isCurrent()) {
    deps.persistDeadLetterSnapshot(sourceKey);
  }
  if (!recovered) {
    // ISS-8615 (marisolashgrove review): a drained cursor with no due dead
    // letters answers nothing, so a healed outage's origin used to ride along
    // for the life of the process — and an isolated failure twenty hours later
    // read its elapsed off that origin and parked the lane on the top rung of
    // a ladder it never climbed. An empty path answers the lane, so it clears
    // the origin here.
    if (stillCurrent()) {
      deps.environmentalDefer.noteLaneAnswered();
    }
    deps.diag.note(
      "info",
      "cursor-empty",
      `no components after keyset (${sinceTs || "epoch"}, ${sinceId || "-"}); nothing to upload`
    );
  }
}
