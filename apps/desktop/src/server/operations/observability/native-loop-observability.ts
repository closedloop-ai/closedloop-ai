import { appendFileSync } from "node:fs";
import path from "node:path";
import type { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import {
  createLoopRunEnvelope,
  type HarnessObservabilityAdapter,
  type LoopRunEnvelope,
  type RawPerfEvent,
  selectObservabilityAdapter,
} from "@closedloop-ai/loops-api/observability";
import {
  createRunningPhaseState,
  emitCanonicalPerfEvent,
  LOOP_PERF_RELATIVE_PATH,
  type RunningPhaseState,
} from "../../../main/loop-perf-telemetry.js";
import type {
  TelemetryEmitter,
  TelemetryTraceContext,
} from "../../../main/telemetry-protocol.js";
import {
  clearActiveAgents,
  markNativeLoop,
  recordActiveAgentDelta,
} from "./active-agents-registry.js";

/**
 * In-process native loop observability (D-006, AC-001/002/004/008).
 *
 * For bare-prompt loops (NativePrompt / ClaudeSlashCommand) symphony-alpha owns
 * loop observability: it synthesizes the run envelope, selects the harness
 * adapter from the loops-api registry, feeds the already-captured harness stream
 * (claude-output.jsonl) through the adapter inside the output tailer's per-line
 * loop, emits canonical `loop.perf.*` events via the desktop emit pipeline, and
 * appends the same raw events to an UN-WATCHED `perf.jsonl` sink (the legacy file
 * watcher is not started for native loops, so there is no double counting).
 *
 * Every operation is wrapped so a telemetry failure never fails or stalls the
 * loop (AC-008).
 */

/** Token delta surfaced back to the output tailer's token accounting. */
export type NativeTokenDelta = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type NativeLoopObservabilityOptions = {
  loopId: string;
  command: string;
  harness: LoopHarness;
  repo?: string;
  branch?: string;
  claudeWorkDir: string;
  traceContext: TelemetryTraceContext;
  telemetryEmitter: TelemetryEmitter;
  /** Injectable clock (defaults to wall-clock); ISO-8601. */
  now?: () => string;
};

export class NativeLoopObservabilitySession {
  private readonly loopId: string;
  private readonly claudeWorkDir: string;
  private readonly traceContext: TelemetryTraceContext;
  private readonly telemetryEmitter: TelemetryEmitter;
  private readonly phaseState: RunningPhaseState = createRunningPhaseState();
  private readonly envelope: LoopRunEnvelope;
  private readonly adapter: HarnessObservabilityAdapter | null;
  private readonly perfJsonlPath: string;
  private finished = false;

  constructor(opts: NativeLoopObservabilityOptions) {
    this.loopId = opts.loopId;
    this.claudeWorkDir = opts.claudeWorkDir;
    this.traceContext = opts.traceContext;
    this.telemetryEmitter = opts.telemetryEmitter;
    this.perfJsonlPath = path.join(opts.claudeWorkDir, LOOP_PERF_RELATIVE_PATH);
    const now = opts.now ?? (() => new Date().toISOString());
    this.envelope = createLoopRunEnvelope(
      {
        loopId: opts.loopId,
        command: opts.command,
        repo: opts.repo,
        branch: opts.branch,
        harness: opts.harness,
      },
      now
    );
    this.adapter = selectObservabilityAdapter(opts.harness, {
      runId: opts.loopId,
      iteration: 1,
      command: opts.command,
      harness: opts.harness,
      now,
    });
    markNativeLoop(opts.loopId);
  }

  /** Whether a harness adapter is producing tool/spawn/agent events. */
  hasAdapter(): boolean {
    return this.adapter !== null;
  }

  /** Synthesize and emit the `run` event at spawn. */
  start(): void {
    try {
      this.emitRaw(this.envelope.runStarted());
    } catch {
      // best-effort (AC-008)
    }
  }

  /**
   * Process one already-`JSON.parse`d harness stream record. Emits canonical
   * events, routes active-agent deltas to the registry, and returns any token
   * delta for the tailer to fold into its Output-event token accounting.
   */
  onRecord(record: Record<string, unknown>): NativeTokenDelta | undefined {
    if (!this.adapter) {
      return undefined;
    }
    try {
      const result = this.adapter.ingest(record);
      for (const event of result.events) {
        this.emitRaw(event);
      }
      for (const delta of result.agentLifecycle) {
        recordActiveAgentDelta(this.loopId, delta);
      }
      if (result.tokenUsage) {
        return {
          inputTokens: result.tokenUsage.input,
          outputTokens: result.tokenUsage.output,
          cacheCreationInputTokens: result.tokenUsage.cacheCreation ?? 0,
          cacheReadInputTokens: result.tokenUsage.cacheRead ?? 0,
        };
      }
    } catch {
      // best-effort: stream drift / parse issues must never stall the loop.
    }
    return undefined;
  }

  /** Synthesize the `iteration` event, flush open items, and clear registry. */
  finish(outcome: { exitCode?: number; status: string }): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    try {
      if (this.adapter) {
        const flushed = this.adapter.flush();
        for (const event of flushed.events) {
          this.emitRaw(event);
        }
        for (const delta of flushed.agentLifecycle) {
          recordActiveAgentDelta(this.loopId, delta);
        }
      }
      this.emitRaw(this.envelope.runFinished(outcome));
    } catch {
      // best-effort (AC-008)
    } finally {
      // Always release registry state so an abnormal exit cannot leak entries.
      clearActiveAgents(this.loopId);
    }
  }

  /** Emit one raw event to telemetry and append it to the un-watched sink. */
  private emitRaw(raw: RawPerfEvent): void {
    try {
      emitCanonicalPerfEvent(raw, {
        phaseState: this.phaseState,
        telemetryEmitter: this.telemetryEmitter,
        traceContext: this.traceContext,
      });
    } catch {
      // telemetry emit failure is non-fatal (AC-008)
    }
    try {
      appendFileSync(this.perfJsonlPath, `${JSON.stringify(raw)}\n`);
    } catch {
      // perf.jsonl sink failure is non-fatal; the in-process emit is authoritative.
    }
  }
}

/** Construct a native observability session for a loop. */
export function createNativeLoopObservabilitySession(
  opts: NativeLoopObservabilityOptions
): NativeLoopObservabilitySession {
  return new NativeLoopObservabilitySession(opts);
}
