import type { LoopHarness } from "../desktop-request";
import type { RawIterationEvent, RawRunEvent } from "./perf-events";

/**
 * Native run/iteration synthesis (AC-004).
 *
 * The legacy plugin path emitted `run`/`iteration` records from
 * `run-loop.sh`/`record_run.sh`. For bare-prompt loops (NativePrompt /
 * ClaudeSlashCommand) symphony-alpha owns this: it stamps a `run` at spawn and a
 * single `iteration` at exit, with consistent non-`unknown` run identity derived
 * from the loopId — no `run-loop.sh` dependency.
 *
 * A bare-prompt invocation has no iteration loop, so exactly one `iteration`
 * (index 1) is synthesized per run (GAP-002).
 */

const SINGLE_ITERATION_INDEX = 1;

/** Identity used to stamp the synthesized run/iteration events. */
export type LoopRunIdentity = {
  /** Canonical run identity — the loopId. Never `unknown` (AC-004). */
  loopId: string;
  /** Canonical command name (PLAN/EXECUTE/…) when known. */
  command?: string;
  /** Repository full name when known. */
  repo?: string;
  /** Branch name when known. */
  branch?: string;
  /** Harness that produced the run (D-007 discriminator). */
  harness: LoopHarness;
};

/** Terminal outcome of the loop, captured at exit. */
export type LoopRunOutcome = {
  /** Harness process exit code. */
  exitCode?: number;
  /** Terminal status string (e.g. "completed", "failed", "cancelled"). */
  status: string;
};

/** Drop `undefined`-valued keys so optional fields are omitted, not null. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}

/**
 * Synthesizes the `run` (spawn) and `iteration` (exit) events for a single
 * native loop. Holds the run start timestamp between the two calls so the
 * iteration's duration is wall-clock accurate.
 */
export class LoopRunEnvelope {
  private readonly identity: LoopRunIdentity;
  private readonly now: () => string;
  private startedAtIso: string | null = null;

  constructor(identity: LoopRunIdentity, now: () => string) {
    this.identity = identity;
    this.now = now;
  }

  /** Build the `run` event and record the start time for the later iteration. */
  runStarted(): RawRunEvent {
    const startedAt = this.now();
    this.startedAtIso = startedAt;
    return compact({
      event: "run",
      run_id: this.identity.loopId,
      started_at: startedAt,
      command: this.identity.command,
      repo: this.identity.repo,
      branch: this.identity.branch,
      harness: this.identity.harness,
    }) as RawRunEvent;
  }

  /**
   * Build the single `iteration` event at exit. Uses the start time captured by
   * `runStarted()`; if `runStarted()` was never called the iteration is stamped
   * with a zero-duration window at exit (fail-open).
   */
  runFinished(outcome: LoopRunOutcome): RawIterationEvent {
    const endedAt = this.now();
    const startedAt = this.startedAtIso ?? endedAt;
    const durationS = Math.max(
      0,
      (Date.parse(endedAt) - Date.parse(startedAt)) / 1000
    );
    return compact({
      event: "iteration",
      run_id: this.identity.loopId,
      iteration: SINGLE_ITERATION_INDEX,
      started_at: startedAt,
      ended_at: endedAt,
      duration_s: Number.isFinite(durationS) ? durationS : 0,
      status: outcome.status,
      claude_exit_code: outcome.exitCode,
      command: this.identity.command,
      harness: this.identity.harness,
    }) as RawIterationEvent;
  }
}

/** Construct a run envelope for a loop. */
export function createLoopRunEnvelope(
  identity: LoopRunIdentity,
  now: () => string = () => new Date().toISOString()
): LoopRunEnvelope {
  return new LoopRunEnvelope(identity, now);
}
