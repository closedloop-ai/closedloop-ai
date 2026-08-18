/**
 * @file agent-session-sync-pass-pump.ts
 * @description Goal stage 3 (ISS-5993): the event-driven pump's STATE MACHINE,
 * extracted as a sibling so the grandfathered (shrink-only)
 * `agent-session-sync-service.ts` does not grow — the same collaborator split
 * stage 2 used for `agent-session-sync-accepted-ack.ts`.
 *
 * The service still owns WHEN to pump (it alone knows `started`, `shouldRun()`,
 * the single-flight guard and the drain timer). This module owns the bookkeeping
 * those decisions read and write:
 *
 * - **Trigger identity.** The FIRST cause asking for the next pass wins, with
 *   its timestamp. Later causes before the pass is admitted coalesce into it,
 *   because the earliest fired timestamp is the honest starvation measurement —
 *   overwriting it with a later trigger would under-report exactly the gap
 *   ISS-5993 is hunting.
 * - **Mid-pass coalescing.** N triggers landing during a running pass fold into
 *   exactly ONE follow-up, so a trigger can never be lost to the single-flight
 *   guard and a burst can never turn into a pass storm.
 * - **The pass trace.** One `gatewayLog` line per pass timestamping
 *   `fired → admitted → started → completed`, which is what names the gating
 *   stage of a starved tick instead of leaving it to inference.
 */
import type { GatewayLogger } from "../logging/gateway-logger.js";
import {
  formatSyncPassTrace,
  isSlowSyncPass,
  SyncPassOutcome,
  type SyncPassTraceSample,
  SyncPassTrigger,
} from "./agent-session-sync-pass-trace.js";

/** The cause + timestamp of the pass a trigger asked for. */
export type SyncPassTriggerRecord = {
  reason: SyncPassTrigger;
  firedAtMs: number;
};

/**
 * One admitted pass's trace bookkeeping. Minted by {@link SyncPassPump.admit},
 * closed by {@link finish}. Holds the mutable outcome so the pass body can
 * narrow it as it makes progress (`abandoned` → `idle` → `sent`) without the
 * service carrying three more fields.
 */
export class SyncPassRun {
  private readonly admittedAtMs = Date.now();
  private startedAtMs: number | null = null;
  private outcome: SyncPassOutcome = SyncPassOutcome.Abandoned;

  private readonly trigger: SyncPassTriggerRecord;
  private readonly log: GatewayLogger;
  private readonly tag: string;

  constructor(trigger: SyncPassTriggerRecord, log: GatewayLogger, tag: string) {
    this.trigger = trigger;
    this.log = log;
    this.tag = tag;
  }

  /**
   * Background-slot admission and source resolution are behind this pass; DB
   * work begins now. From here an uneventful pass is `idle`, not `abandoned`.
   */
  noteStarted(): void {
    this.startedAtMs = Date.now();
    this.outcome = SyncPassOutcome.Idle;
  }

  noteOutcome(outcome: SyncPassOutcome): void {
    this.outcome = outcome;
  }

  /** Render + route the one-line trace for this pass. */
  finish(): void {
    const sample: SyncPassTraceSample = {
      trigger: this.trigger.reason,
      firedAtMs: this.trigger.firedAtMs,
      admittedAtMs: this.admittedAtMs,
      startedAtMs: this.startedAtMs,
      completedAtMs: Date.now(),
      outcome: this.outcome,
    };
    const line = formatSyncPassTrace(sample);
    // A pass that sent, failed, or was slow anywhere is INFO (the ISS-5993
    // evidence); a fast idle sweep is debug so a healthy 5s cadence does not
    // write ~17k lines/day.
    if (
      this.outcome === SyncPassOutcome.Sent ||
      this.outcome === SyncPassOutcome.Failed ||
      isSlowSyncPass(sample)
    ) {
      this.log.info(this.tag, line);
      return;
    }
    this.log.debug(this.tag, line);
  }
}

export class SyncPassPump {
  private requestedWhileRunning = false;
  private pending: SyncPassTriggerRecord | null = null;

  private readonly log: GatewayLogger;
  private readonly tag: string;

  constructor(log: GatewayLogger, tag: string) {
    this.log = log;
    this.tag = tag;
  }

  /** Record the FIRST cause asking for the next pass (later causes coalesce). */
  markTrigger(reason: SyncPassTrigger): void {
    if (this.pending === null) {
      this.pending = { reason, firedAtMs: Date.now() };
    }
  }

  /** A trigger landed while a pass was running — fold it into one follow-up. */
  requestWhileRunning(): void {
    this.requestedWhileRunning = true;
  }

  /**
   * Admit a pass: consume the pending trigger and mint its run. A pass with no
   * recorded trigger (a direct legacy call path) reads as a poll tick. Clears
   * the mid-pass request because THIS pass will observe every trigger that
   * fired before it started; only triggers arriving during it warrant a
   * follow-up.
   */
  admit(): SyncPassRun {
    const trigger = this.pending ?? {
      reason: SyncPassTrigger.Poll,
      firedAtMs: Date.now(),
    };
    this.pending = null;
    this.requestedWhileRunning = false;
    return new SyncPassRun(trigger, this.log, this.tag);
  }

  /**
   * Whether the finished pass owes exactly one coalesced follow-up. Consumes
   * the request, so two calls never schedule two passes.
   */
  takeFollowUp(): boolean {
    if (!this.requestedWhileRunning) {
      return false;
    }
    this.requestedWhileRunning = false;
    return true;
  }

  /**
   * Drop pump state with the rest of the in-flight machinery — a queued
   * follow-up or trigger mark belongs to the ended lifecycle.
   */
  reset(): void {
    this.requestedWhileRunning = false;
    this.pending = null;
  }
}
