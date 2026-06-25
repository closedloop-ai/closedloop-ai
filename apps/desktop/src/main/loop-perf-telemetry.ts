import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import path from "node:path";
import {
  perfEventSchema,
  type RawPerfEvent,
  truncateUtf8,
} from "@closedloop-ai/loops-api/observability";
import { z } from "zod";
import {
  countNewlinesBeforeOffset,
  getJsonlFileOffset,
} from "./telemetry-file-utils.js";
import type {
  LoopPerfEventDiagnostics,
  TelemetryCategory,
  TelemetryEmitter,
  TelemetryTraceContext,
} from "./telemetry-protocol.js";

export const LOOP_PERF_RELATIVE_PATH = "perf.jsonl";
const LOOP_PERF_COMMAND_MAX_BYTES = 64;
const LOOP_PERF_PARSE_FAILURE_RAW_BYTES_MAX_BYTES = 1024;
const LOOP_PERF_PARSE_FAILURE_ERROR_MESSAGE_MAX_BYTES = 512;
const LOOP_PERF_PARSE_FAILURE_MAX_EVENTS_PER_CHUNK = 20;

// biome-ignore lint/complexity/useRegexLiterals: Control characters (\u001b, \u009b) required for ANSI stripping
const ANSI_RE = new RegExp(
  String.raw`[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const CREDENTIAL_RE =
  /(?:["']?\b(?:authorization|password|(?:[a-z0-9]+[_-])*token|(?:[a-z0-9]+[_-])*api[_-]?key|(?:[a-z0-9]+[_-])*secret)\b["']?\s*(?::|=|\s+)\s*["']?\S+|\bbearer\s+\S+|\bsk[-_][a-z0-9]+|\bgh[pousr]_[a-z0-9_]+|\bxox[abprs]-[a-z0-9-]+)/i;

function getLoopPerfTelemetryFilePath(workdir: string): string {
  return path.join(workdir, LOOP_PERF_RELATIVE_PATH);
}

function stripUnsafeText(input: string): string {
  return input.replaceAll(ANSI_RE, "").replaceAll(CONTROL_CHARS_RE, "");
}

function redactCredentialLikeText(input: string): string {
  return CREDENTIAL_RE.test(input) ? "[redacted]" : input;
}

function sanitizeLoopPerfCommand(
  command: string | null | undefined
): string | undefined {
  if (command === null || command === undefined) {
    return undefined;
  }
  const stripped = stripUnsafeText(command).trim();
  if (stripped.length === 0) {
    return undefined;
  }
  return truncateUtf8(
    redactCredentialLikeText(stripped),
    LOOP_PERF_COMMAND_MAX_BYTES
  );
}

function loopPerfCommandProjection(
  command: string | null | undefined
): Partial<Record<"command", string>> {
  return optional("command", sanitizeLoopPerfCommand(command));
}

function sanitizeLoopPerfRawBytes(rawBytes: string): string {
  return truncateUtf8(
    redactCredentialLikeText(stripUnsafeText(rawBytes)),
    LOOP_PERF_PARSE_FAILURE_RAW_BYTES_MAX_BYTES
  );
}

function sanitizeLoopPerfErrorMessage(errorMessage: string): string {
  return truncateUtf8(
    redactCredentialLikeText(stripUnsafeText(errorMessage)),
    LOOP_PERF_PARSE_FAILURE_ERROR_MESSAGE_MAX_BYTES
  );
}

/**
 * Capture the current byte-offset of `perf.jsonl` before the orchestrator
 * spawns. This is the initial high-water mark (HWM) used by the streaming
 * watcher and reconciliation pass to avoid re-emitting records written by a
 * previous run.
 */
export function getLoopPerfTelemetryOffset(workdir: string): number {
  return getJsonlFileOffset(getLoopPerfTelemetryFilePath(workdir));
}

/**
 * Read [0, startOffset) of `filePath` and count complete lines (LF bytes).
 * Used to seed `lineNumberBase` so parse-failure diagnostics report the
 * absolute line number within `perf.jsonl` even when the watcher resumes from
 * a non-zero offset (e.g. the file already contained records from a prior run).
 *
 * Returns 0 when the file is missing, unreadable, or `startOffset <= 0`.
 */
function seedLineNumberBase(filePath: string, startOffset: number): number {
  if (startOffset <= 0) {
    return 0;
  }
  // Read only the leading `startOffset` bytes via openSync/readSync rather
  // than slurping the whole file with readFileSync. On a reused
  // claudeWorkDir, perf.jsonl can accumulate megabytes of records across
  // prior runs; a full read just to count newlines in the prefix is wasted
  // I/O. Mirrors the file-descriptor pattern already used by readBytesFrom
  // elsewhere in this module.
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    // Missing or unreadable file — treat as no prior content.
    return 0;
  }
  try {
    const buf = Buffer.alloc(startOffset);
    const bytesRead = readSync(fd, buf, 0, startOffset, 0);
    if (bytesRead <= 0) {
      return 0;
    }
    return countNewlinesBeforeOffset(buf, bytesRead);
  } catch {
    return 0;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore — close errors must not affect the seeded line count */
    }
  }
}

/**
 * Snapshot the names of every file currently in `${workdir}/.tool-calls/`.
 * Used as the orphan-sentinel baseline: at reconcile time, any file already
 * present at watcher start is excluded so prior-run orphans (left behind by
 * an earlier killed loop on a reused claudeWorkDir) are not re-emitted under
 * this run's trace context.
 *
 * Returns an empty set when the directory is missing or unreadable.
 */
function snapshotToolCallsBaseline(workdir: string): ReadonlySet<string> {
  const toolCallsDir = path.join(workdir, ".tool-calls");
  try {
    if (!existsSync(toolCallsDir)) {
      return new Set();
    }
    return new Set(readdirSync(toolCallsDir));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Raw perf.jsonl event schema.
//
// The per-event Zod schemas + discriminated union were relocated to
// `@closedloop-ai/loops-api/observability` as the SSOT (Q-001/D-005) so the
// in-process harness adapters and this file-tail emit pipeline validate against
// one definition. `perfEventSchema`/`RawPerfEvent` are imported above; the emit
// pipeline (phase attribution, sanitization, category mapping, emit) stays here.
// ---------------------------------------------------------------------------

/**
 * Producer-emitted event types we deliberately do not surface as
 * `loop.perf.*` telemetry today. They are valid records and must NOT be
 * reported as parse failures — the producer is allowed to emit them, the
 * desktop simply does not have a corresponding telemetry category yet.
 * Add a schema + category here (and remove the entry) when promoting one
 * of these to first-class telemetry.
 */
const KNOWN_UNSUPPORTED_PERF_EVENTS: ReadonlySet<string> = new Set([
  "post_loop_review",
  "post_loop_fix",
]);

// ---------------------------------------------------------------------------
// File I/O helper — reads new bytes from `filePath` starting at `offset`.
// ---------------------------------------------------------------------------

/**
 * Read bytes from `filePath` starting at byte `offset` up to the current EOF.
 * Returns `null` when there are no new bytes (file missing, empty delta, or
 * I/O error). All errors are silently swallowed so callers stay fail-open.
 */
function readBytesFrom(filePath: string, offset: number): Buffer | null {
  let fileSize: number;
  try {
    fileSize = existsSync(filePath) ? statSync(filePath).size : offset;
  } catch {
    return null;
  }

  const bytesToRead = fileSize - offset;
  if (bytesToRead <= 0) {
    return null;
  }

  const buf = Buffer.allocUnsafe(bytesToRead);
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }

  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buf, 0, bytesToRead, offset);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  if (bytesRead <= 0) {
    return null;
  }
  return bytesRead === bytesToRead ? buf : buf.subarray(0, bytesRead);
}

// ---------------------------------------------------------------------------
// Running-phase state
// ---------------------------------------------------------------------------

/**
 * Streaming running-phase state keyed by `${run_id}:${iteration}`.
 * Maintained across calls to `parseAndEmitChunk` within the same watcher
 * context, so phase attribution is applied to tool/skill/agent/spawn events
 * that follow a `phase` event in the stream.
 */
export type RunningPhaseState = Map<string, string>;

export function createRunningPhaseState(): RunningPhaseState {
  return new Map<string, string>();
}

/** Returns the phase-state key for a given (run_id, iteration) pair. */
function phaseKey(runId: string, iteration: number): string {
  return `${runId}:${iteration}`;
}

// ---------------------------------------------------------------------------
// Context passed to parseAndEmitChunk
// ---------------------------------------------------------------------------

export type ParseChunkContext = {
  /** Streaming running-phase state shared across watcher ticks. */
  phaseState: RunningPhaseState;
  /**
   * Any bytes from the previous watcher tick that did not end with a newline.
   * The caller must provide the current buffer and receive back the updated one.
   */
  priorLineBuffer: string;
  /** Telemetry emitter to publish events. */
  telemetryEmitter: TelemetryEmitter;
  /** Trace context attached to every emitted telemetry event. */
  traceContext: TelemetryTraceContext;
  /**
   * Line counter tracking the absolute line number within the file for use in
   * parse-failure diagnostics. The caller must initialise this to the line
   * number of the first byte in `startOffset` (typically obtained from
   * `countNewlinesBeforeOffset`).
   */
  lineNumberBase: number;
};

export type ParseChunkResult = {
  /** Remaining trailing bytes that do not end with a newline. */
  newPriorLineBuffer: string;
  /** Updated absolute line number after processing this chunk. */
  newLineNumberBase: number;
};

// ---------------------------------------------------------------------------
// Snake → camelCase conversion helpers
// ---------------------------------------------------------------------------

/**
 * Build a `{ key: value }` object only when `value` is non-null and defined.
 * Used by `toLoopPerfDiagnostics` to OMIT optional fields that the producer
 * record left absent, rather than synthesising `null` — symphony-alpha may
 * add optional-but-non-nullable schemas for these fields, where an explicit
 * null would cause the event to be rejected.
 */
function optional<K extends string, V>(
  key: K,
  value: V | null | undefined
): Partial<Record<K, V>> {
  return value === null || value === undefined
    ? {}
    : ({ [key]: value } as Partial<Record<K, V>>);
}

function toLoopPerfDiagnostics(
  raw: RawPerfEvent,
  attributedPhase: string | null
): LoopPerfEventDiagnostics {
  switch (raw.event) {
    case "run":
      return {
        event: "run",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        startedAt: raw.started_at,
        ...loopPerfCommandProjection(raw.command),
        ...optional("repo", raw.repo),
        ...optional("branch", raw.branch),
      };
    case "phase":
      return {
        event: "phase",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        iteration: raw.iteration,
        phase: raw.phase,
        status: raw.status,
        startedAt: raw.started_at,
        ...optional("startSha", raw.start_sha),
        ...loopPerfCommandProjection(raw.command),
      };
    case "iteration":
      return {
        event: "iteration",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        iteration: raw.iteration,
        startedAt: raw.started_at,
        endedAt: raw.ended_at,
        durationS: raw.duration_s,
        status: raw.status,
        ...loopPerfCommandProjection(raw.command),
        ...optional("claudeExitCode", raw.claude_exit_code),
      };
    case "pipeline_step":
      return {
        event: "pipeline_step",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        iteration: raw.iteration,
        step: raw.step,
        stepName: raw.step_name,
        startedAt: raw.started_at,
        endedAt: raw.ended_at,
        durationS: raw.duration_s,
        skipped: raw.skipped,
        ...loopPerfCommandProjection(raw.command),
        ...optional("exitCode", raw.exit_code),
      };
    case "agent":
      return {
        event: "agent",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        iteration: raw.iteration,
        agentId: raw.agent_id,
        agentType: raw.agent_type,
        agentName: raw.agent_name,
        startedAt: raw.started_at,
        endedAt: raw.ended_at,
        durationS: raw.duration_s,
        ...loopPerfCommandProjection(raw.command),
        ...optional("model", raw.model),
        ...optional("parentSessionId", raw.parent_session_id),
        ...optional("inputTokens", raw.input_tokens),
        ...optional("outputTokens", raw.output_tokens),
        ...optional(
          "cacheCreationInputTokens",
          raw.cache_creation_input_tokens
        ),
        ...optional("cacheReadInputTokens", raw.cache_read_input_tokens),
        ...optional("totalContextTokens", raw.total_context_tokens),
        ...optional("phase", attributedPhase),
      };
    case "tool":
      return {
        event: "tool",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        iteration: raw.iteration,
        agentId: raw.agent_id,
        toolName: raw.tool_name,
        startedAt: raw.started_at,
        ...loopPerfCommandProjection(raw.command),
        ...optional("endedAt", raw.ended_at),
        ...optional("durationS", raw.duration_s),
        ...optional("ok", raw.ok),
        ...optional("phase", attributedPhase),
      };
    case "skill":
      return {
        event: "skill",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        iteration: raw.iteration,
        agentId: raw.agent_id,
        toolName: raw.tool_name,
        skillName: raw.skill_name,
        startedAt: raw.started_at,
        endedAt: raw.ended_at,
        durationS: raw.duration_s,
        ok: raw.ok,
        ...loopPerfCommandProjection(raw.command),
        ...optional("phase", attributedPhase),
      };
    case "spawn":
      return {
        event: "spawn",
        runId: raw.run_id,
        ...optional("harness", raw.harness),
        iteration: raw.iteration,
        parentAgentId: raw.parent_agent_id,
        startedAt: raw.started_at,
        ...loopPerfCommandProjection(raw.command),
        ...optional("parentSessionId", raw.parent_session_id),
        ...optional("plannedSubagentType", raw.planned_subagent_type),
        ...optional("phase", attributedPhase),
      };
  }
}

/**
 * Map a Zod-validated `event` value to its `loop.perf.*` TelemetryCategory.
 *
 * Declared as `Record<RawPerfEvent["event"], TelemetryCategory>` so the
 * compiler enforces parity between the schema variants and the telemetry
 * category enum: adding a new event to the discriminated union without
 * adding the matching `loop.perf.<name>` category will produce a TS error
 * here instead of silently emitting an unrecognised category at runtime.
 */
const PERF_EVENT_CATEGORIES: Record<RawPerfEvent["event"], TelemetryCategory> =
  {
    run: "loop.perf.run",
    phase: "loop.perf.phase",
    iteration: "loop.perf.iteration",
    pipeline_step: "loop.perf.pipeline_step",
    agent: "loop.perf.agent",
    tool: "loop.perf.tool",
    skill: "loop.perf.skill",
    spawn: "loop.perf.spawn",
  };

function eventToCategory(event: RawPerfEvent["event"]): TelemetryCategory {
  return PERF_EVENT_CATEGORIES[event];
}

function emitLoopPerfParseFailure(
  ctx: ParseChunkContext,
  options: {
    message: string;
    lineNumber: number;
    rawBytes: string;
    errorMessage: string;
  }
): void {
  ctx.telemetryEmitter.emit({
    severity: "warn",
    category: "loop.perf.parse_failure",
    message: options.message,
    trace: ctx.traceContext,
    diagnostics: {
      loopPerf: {
        event: "parse_failure",
        lineNumber: options.lineNumber,
        rawBytes: sanitizeLoopPerfRawBytes(options.rawBytes),
        errorMessage: sanitizeLoopPerfErrorMessage(options.errorMessage),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// emitCanonicalPerfEvent — transport-agnostic emit pipeline (T-1.2)
// ---------------------------------------------------------------------------

/** Context for the transport-agnostic canonical perf-event emit pipeline. */
export type EmitCanonicalPerfEventContext = {
  /** Running-phase state shared across the feeding transport. */
  phaseState: RunningPhaseState;
  /** Telemetry emitter to publish events. */
  telemetryEmitter: TelemetryEmitter;
  /** Trace context attached to every emitted telemetry event. */
  traceContext: TelemetryTraceContext;
};

/**
 * Validate→phase-attribution→camelCase→emit for a single already-validated raw
 * perf event. Extracted from `parseAndEmitChunk` so both the legacy file-tail
 * path and the in-process harness adapter path (native loops) share one emit
 * pipeline (sanitization, phase attribution, category mapping). The raw schema
 * lives in `@closedloop-ai/loops-api/observability`; this stays desktop-side.
 */
export function emitCanonicalPerfEvent(
  raw: RawPerfEvent,
  ctx: EmitCanonicalPerfEventContext
): void {
  // Running-phase state update — a phase record sets the attribution for
  // subsequent agent/tool/skill/spawn events in the same (run_id, iteration).
  if (raw.event === "phase") {
    ctx.phaseState.set(phaseKey(raw.run_id, raw.iteration), raw.phase);
  }

  // Phase attribution for agent/tool/skill/spawn events.
  let attributedPhase: string | null = null;
  if (
    raw.event === "agent" ||
    raw.event === "tool" ||
    raw.event === "skill" ||
    raw.event === "spawn"
  ) {
    attributedPhase =
      ctx.phaseState.get(phaseKey(raw.run_id, raw.iteration)) ?? null;
  }

  const diagPayload = toLoopPerfDiagnostics(raw, attributedPhase);
  const category = eventToCategory(raw.event);
  ctx.telemetryEmitter.emit({
    severity: "info",
    category,
    message: `loop perf: ${raw.event}`,
    trace: ctx.traceContext,
    diagnostics: {
      loopPerf: diagPayload,
    },
  });
}

// ---------------------------------------------------------------------------
// parseAndEmitChunk — the main streaming helper
// ---------------------------------------------------------------------------

/**
 * Parse a byte buffer appended to `perf.jsonl` and emit one telemetry event
 * per complete JSON line.
 *
 * - Prepends any prior partial line (trailing bytes from the previous watcher
 *   tick that did not end with a newline).
 * - Splits the combined text on newlines; processes each complete line.
 * - Validates each line against the Zod discriminated-union schema.
 * - Converts snake_case fields to camelCase at the boundary.
 * - Applies running-phase attribution to `agent`, `tool`, `skill`, `spawn`
 *   events.
 * - Emits one `loop.perf.{event}` telemetry event per valid record.
 * - Emits `loop.perf.parse_failure` (warning severity) for malformed JSON or
 *   Zod validation failures; continues processing remaining lines.
 * - Returns the updated prior-line buffer (any trailing text after the last
 *   newline) and updated line-number base.
 *
 * This function is intentionally free of I/O — all reading is the caller's
 * responsibility.
 */
export function parseAndEmitChunk(
  chunk: Buffer,
  ctx: ParseChunkContext
): ParseChunkResult {
  // Decode the incoming buffer as UTF-8 text and prepend any buffered partial
  // line from the previous watcher tick.
  const text = ctx.priorLineBuffer + chunk.toString("utf-8");

  // Split on LF (or CRLF), keeping only "complete" lines — i.e. all parts
  // before the final segment. The final segment may be empty (if the chunk
  // ended with \n) or a partial line (if it did not).
  const parts = text.split("\n");
  // The last element is either an empty string (chunk ended with \n) or a
  // partial line that needs buffering.
  const newPriorLineBuffer = parts.at(-1) ?? "";
  const completeLines = parts.slice(0, -1);

  let lineNumber = ctx.lineNumberBase;
  let parseFailureEventsEmitted = 0;
  let parseFailuresSuppressed = 0;

  for (const rawLine of completeLines) {
    lineNumber += 1;

    // Strip trailing \r from CRLF sequences.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    // Skip blank lines (e.g. trailing newline at EOF).
    if (!line) {
      continue;
    }

    // --- JSON parsing ---
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      if (
        parseFailureEventsEmitted < LOOP_PERF_PARSE_FAILURE_MAX_EVENTS_PER_CHUNK
      ) {
        emitLoopPerfParseFailure(ctx, {
          message: "perf.jsonl: malformed JSON line",
          lineNumber,
          rawBytes: line,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        parseFailureEventsEmitted += 1;
      } else {
        parseFailuresSuppressed += 1;
      }
      continue;
    }

    // --- Skip producer-emitted events we don't yet surface as telemetry ---
    // The discriminated union below would otherwise reject these as Zod
    // failures and emit a parse_failure for each one, polluting Datadog with
    // false-positive warnings on every normal run.
    if (
      typeof parsedJson === "object" &&
      parsedJson !== null &&
      "event" in parsedJson &&
      typeof (parsedJson as { event: unknown }).event === "string" &&
      KNOWN_UNSUPPORTED_PERF_EVENTS.has((parsedJson as { event: string }).event)
    ) {
      continue;
    }

    // --- Zod validation ---
    const parsed = perfEventSchema.safeParse(parsedJson);
    if (!parsed.success) {
      if (
        parseFailureEventsEmitted < LOOP_PERF_PARSE_FAILURE_MAX_EVENTS_PER_CHUNK
      ) {
        emitLoopPerfParseFailure(ctx, {
          message: "perf.jsonl: Zod validation failure",
          lineNumber,
          rawBytes: line,
          errorMessage: parsed.error.message,
        });
        parseFailureEventsEmitted += 1;
      } else {
        parseFailuresSuppressed += 1;
      }
      continue;
    }

    // --- Phase attribution + camelCase conversion + emit (shared pipeline) ---
    emitCanonicalPerfEvent(parsed.data, {
      phaseState: ctx.phaseState,
      telemetryEmitter: ctx.telemetryEmitter,
      traceContext: ctx.traceContext,
    });
  }

  if (parseFailuresSuppressed > 0) {
    emitLoopPerfParseFailure(ctx, {
      message: "perf.jsonl: parse failures suppressed",
      lineNumber,
      rawBytes: "",
      errorMessage: `${parseFailuresSuppressed} additional parse failure event(s) suppressed in this chunk`,
    });
  }

  return {
    newPriorLineBuffer,
    newLineNumberBase: lineNumber,
  };
}

// ---------------------------------------------------------------------------
// Watcher handle interface
// ---------------------------------------------------------------------------

/** Handle returned by `startLoopPerfTelemetryWatcher`. */
export type LoopPerfTelemetryWatcherHandle = {
  /** Stop the file watcher and release resources. */
  stop(): Promise<void>;
  /** Return the current high-water mark (byte offset into perf.jsonl). */
  getHwm(): number;
  /** Return the running-phase state accumulated across watcher ticks. */
  getPhaseState(): RunningPhaseState;
  /**
   * Return the absolute line number of the last byte the watcher consumed,
   * so the reconciliation catch-up can continue numbering from there for
   * parse-failure diagnostics.
   */
  getLineNumberBase(): number;
  /**
   * Return any trailing bytes the watcher consumed that did not end with a
   * newline. These bytes are part of an incomplete JSON record at the
   * watcher's HWM and must be prepended to the reconcile catch-up read so the
   * record is not dropped or reported as a parse failure.
   */
  getPriorLineBuffer(): string;
  /**
   * Return the snapshot of `.tool-calls/` filenames captured at watcher start.
   * The reconcile pass filters orphaned-sentinel emission against this set so
   * sentinels left behind by a prior killed loop on a reused workdir are not
   * re-emitted under the current run's trace context.
   */
  getToolCallsBaseline(): ReadonlySet<string>;
};

// ---------------------------------------------------------------------------
// startLoopPerfTelemetryWatcher
// ---------------------------------------------------------------------------

/**
 * Open a file-system watcher on `${workdir}/perf.jsonl` and stream records to
 * telemetry as the Loop orchestrator appends them.
 *
 * Design notes:
 * - Uses `fs.watch` (Node built-in) which on macOS/Linux uses native OS events
 *   (kqueue / inotify) — equivalent to chokidar with `usePolling: false` and
 *   `awaitWriteFinish: false`.
 * - Each watcher event is debounced ~250ms (Q-001 default) to coalesce rapid
 *   bursts of appends and reduce Socket.IO traffic.
 * - Each debounced tick reads from the current HWM to the current EOF, passes
 *   the buffer to `parseAndEmitChunk`, and advances the HWM by the consumed
 *   bytes so the reconciliation pass does not re-emit them.
 * - Any error within a watcher tick is caught; a `loop.perf.parse_failure`
 *   warning event is emitted but the watcher continues watching.
 * - If `fs.watch` itself fails to initialise, a `loop.perf.parse_failure`
 *   warning is emitted and the returned handle is a no-op (the reconciliation
 *   pass will catch all records at process exit).
 *
 * @param workdir - The Loop working directory (contains `perf.jsonl`).
 * @param options.startOffset - Initial HWM (byte offset captured before spawn).
 * @param options.traceContext - Trace context attached to every emitted event.
 * @param options.telemetryEmitter - Emitter used to publish telemetry events.
 * @returns A handle with `stop()`, `getHwm()`, and `getPhaseState()` methods.
 */
export function startLoopPerfTelemetryWatcher(
  workdir: string,
  options: {
    startOffset: number;
    traceContext: TelemetryTraceContext;
    telemetryEmitter: TelemetryEmitter;
  }
): LoopPerfTelemetryWatcherHandle {
  const { startOffset, traceContext, telemetryEmitter } = options;
  const filePath = getLoopPerfTelemetryFilePath(workdir);

  // Mutable watcher state — advanced by each successful tick.
  let hwm = startOffset;
  let priorLineBuffer = "";
  // Seed lineNumberBase from any pre-existing content covered by startOffset
  // so parse-failure diagnostics report the absolute line within perf.jsonl
  // (per the ParseChunkContext contract).
  let lineNumberBase = seedLineNumberBase(filePath, startOffset);
  const phaseState: RunningPhaseState = createRunningPhaseState();
  // Capture the .tool-calls/ baseline here (not inside the fs.watch try/catch)
  // so the orphan-sentinel filter remains correct even when fs.watch itself
  // fails and the watcher returns a no-op handle.
  const toolCallsBaseline = snapshotToolCallsBaseline(workdir);

  // Debounce timer handle.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Read from the current HWM to EOF and call `parseAndEmitChunk`.
   * Wrapped in try/catch — any error emits a warning and does not crash the
   * watcher.
   */
  function tick(): void {
    try {
      const chunk = readBytesFrom(filePath, hwm);
      if (!chunk) {
        return;
      }

      const result = parseAndEmitChunk(chunk, {
        phaseState,
        priorLineBuffer,
        telemetryEmitter,
        traceContext,
        lineNumberBase,
      });

      // Advance HWM and update buffered state.
      hwm += chunk.length;
      priorLineBuffer = result.newPriorLineBuffer;
      lineNumberBase = result.newLineNumberBase;
    } catch (err) {
      // Emit a warning-severity parse_failure so the error is visible in
      // Datadog without crashing the watcher.
      try {
        telemetryEmitter.emit({
          severity: "warn",
          category: "loop.perf.parse_failure",
          message: "perf.jsonl watcher tick error",
          trace: traceContext,
          diagnostics: {
            loopPerf: {
              event: "parse_failure",
              lineNumber: lineNumberBase,
              rawBytes: "",
              errorMessage: sanitizeLoopPerfErrorMessage(
                err instanceof Error ? err.message : String(err)
              ),
            },
          },
        });
      } catch {
        // If even the telemetry emit fails, swallow silently.
      }
    }
  }

  /**
   * Debounced event handler — schedules a tick to run ~250ms after the last
   * watcher event, coalescing rapid bursts of file-append notifications.
   */
  function scheduleTick(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      tick();
    }, 250);
  }

  // Start the watcher. We watch the parent workdir (not perf.jsonl directly)
  // so that the watcher works whether or not perf.jsonl already exists at
  // startup — the orchestrator typically creates the file shortly after we
  // begin watching. fs.watch on a directory fires (eventType, filename) for
  // each direct child; we filter for perf.jsonl. macOS occasionally reports
  // filename=null, in which case we tick defensively (tick is idempotent and
  // a no-op when there are no new bytes).
  // If fs.watch throws (e.g. workdir does not exist or unsupported mount
  // type), emit a warning and return a no-op handle so the reconciliation
  // pass takes over at process exit.
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(workdir, { persistent: false }, (_eventType, filename) => {
      if (filename === null || filename === LOOP_PERF_RELATIVE_PATH) {
        scheduleTick();
      }
    });

    // FSWatcher emits 'error' asynchronously when the underlying handle becomes
    // invalid (e.g. the workdir is removed). Without a listener, EventEmitter
    // throws ERR_UNHANDLED_ERROR as an uncaught exception.
    watcher.on("error", (err: unknown) => {
      try {
        telemetryEmitter.emit({
          severity: "warn",
          category: "loop.perf.parse_failure",
          message: "perf.jsonl watcher emitted error",
          trace: traceContext,
          diagnostics: {
            loopPerf: {
              event: "parse_failure",
              lineNumber: lineNumberBase,
              rawBytes: "",
              errorMessage: sanitizeLoopPerfErrorMessage(
                err instanceof Error ? err.message : String(err)
              ),
            },
          },
        });
      } catch {
        // Swallow.
      }
      if (watcher !== null) {
        try {
          watcher.close();
        } catch {
          // Ignore close errors.
        }
        watcher = null;
      }
    });

    // Also trigger an initial tick in case bytes were appended between
    // startOffset capture and watcher startup.
    scheduleTick();
  } catch (err) {
    try {
      telemetryEmitter.emit({
        severity: "warn",
        category: "loop.perf.parse_failure",
        message: "perf.jsonl watcher failed to initialise",
        trace: traceContext,
        diagnostics: {
          loopPerf: {
            event: "parse_failure",
            lineNumber: 0,
            rawBytes: "",
            errorMessage: sanitizeLoopPerfErrorMessage(
              err instanceof Error ? err.message : String(err)
            ),
          },
        },
      });
    } catch {
      // Swallow.
    }
    // Return a no-op handle — reconciliation pass will cover all records.
    return {
      stop: () => Promise.resolve(),
      getHwm: () => hwm,
      getPhaseState: () => phaseState,
      getLineNumberBase: () => lineNumberBase,
      getPriorLineBuffer: () => priorLineBuffer,
      getToolCallsBaseline: () => toolCallsBaseline,
    };
  }

  return {
    stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        // Cancel any pending debounce tick.
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        // Perform one final synchronous tick to flush bytes appended just
        // before stop() was called (e.g. the last lines before process exit).
        tick();
        // Close the watcher.
        if (watcher !== null) {
          try {
            watcher.close();
          } catch {
            // Ignore close errors.
          }
          watcher = null;
        }
        resolve();
      });
    },

    getHwm(): number {
      return hwm;
    },

    getPhaseState(): RunningPhaseState {
      return phaseState;
    },

    getLineNumberBase(): number {
      return lineNumberBase;
    },

    getPriorLineBuffer(): string {
      return priorLineBuffer;
    },

    getToolCallsBaseline(): ReadonlySet<string> {
      return toolCallsBaseline;
    },
  };
}

// ---------------------------------------------------------------------------
// reconcileLoopPerfTelemetry
// ---------------------------------------------------------------------------

/**
 * Zod schema for the content of a sentinel file in `${workdir}/.tool-calls/`.
 * Each sentinel represents a tool call that was started but whose post-hook
 * never fired (e.g. the Loop was killed mid-run via SIGTERM).
 *
 * Fields that may not be present in older sentinel files use `.nullish()` so
 * they parse cleanly with missing values rendered as `null`.
 */
const sentinelSchema = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  tool_name: z.string(),
  started_at: z.string(),
  iteration: z.number().int(),
  command: z.string().nullish(),
});

/**
 * End-of-loop reconciliation pass.
 *
 * Responsibilities:
 * 1. Read any bytes of `perf.jsonl` that the streaming watcher missed (bytes
 *    from the watcher's final HWM to EOF) and emit them via `parseAndEmitChunk`.
 *    Running-phase state is carried forward from the watcher so phase
 *    attribution remains consistent across the streaming → reconcile boundary.
 * 2. Walk `${workdir}/.tool-calls/` for sentinel files. Each remaining file
 *    represents an orphaned tool call (the post-hook never fired). Emit one
 *    `loop.perf.tool` telemetry event per orphan with the sentinel's metadata
 *    and `ended_at: null, duration_s: null, ok: null`.
 *
 * The entire function is wrapped in try/catch so any failure is fail-open: it
 * emits a warning telemetry event and returns without affecting the Loop's
 * exit code or produced artifacts.
 *
 * @param workdir - The Loop working directory (contains `perf.jsonl` and
 *   optionally `.tool-calls/`).
 * @param options.startOffset - Initial HWM (byte offset captured before spawn).
 *   Used only when no `watcherHandle` is provided.
 * @param options.traceContext - Trace context attached to every emitted event.
 * @param options.telemetryEmitter - Emitter used to publish telemetry events.
 * @param options.watcherHandle - Optional handle returned by
 *   `startLoopPerfTelemetryWatcher`. If provided, its final HWM and
 *   running-phase state are used as the starting point for reconciliation.
 */
export function reconcileLoopPerfTelemetry(
  workdir: string,
  options: {
    startOffset: number;
    traceContext: TelemetryTraceContext;
    telemetryEmitter: TelemetryEmitter;
    watcherHandle?: LoopPerfTelemetryWatcherHandle;
  }
): void {
  const { startOffset, traceContext, telemetryEmitter, watcherHandle } =
    options;

  try {
    // -----------------------------------------------------------------------
    // Step 1: Determine the starting HWM and phase state.
    // If a watcher handle is provided, inherit its final HWM and phase state
    // (the watcher's stop() should have already been called by the caller).
    // Otherwise start fresh from the captured startOffset.
    // -----------------------------------------------------------------------
    const hwm = watcherHandle ? watcherHandle.getHwm() : startOffset;
    const phaseState: RunningPhaseState = watcherHandle
      ? watcherHandle.getPhaseState()
      : createRunningPhaseState();
    // Inherit the watcher's partial-line buffer and line counter so a record
    // that straddled the watcher → reconcile boundary is parsed once (not lost
    // and not double-emitted) and parse-failure diagnostics keep absolute line
    // numbers within perf.jsonl.
    const inheritedPriorLineBuffer = watcherHandle
      ? watcherHandle.getPriorLineBuffer()
      : "";
    const filePath = getLoopPerfTelemetryFilePath(workdir);
    const inheritedLineNumberBase = watcherHandle
      ? watcherHandle.getLineNumberBase()
      : seedLineNumberBase(filePath, startOffset);
    // Sentinels present in `.tool-calls/` before the watcher started belong to
    // an earlier loop on this reused workdir. Skip them on emit so prior-run
    // orphans aren't re-reported with the current command's trace context.
    const inheritedToolCallsBaseline: ReadonlySet<string> = watcherHandle
      ? watcherHandle.getToolCallsBaseline()
      : new Set();

    // -----------------------------------------------------------------------
    // Step 2: Catch-up read — emit any perf.jsonl records the watcher missed.
    // We append a synthetic "\n" so that:
    //   (a) a final record buffered in `inheritedPriorLineBuffer` (the loop
    //       crashed mid-write before the trailing newline) is flushed even
    //       when no new bytes are appended, and
    //   (b) a final record that the catch-up read picked up but that lacks a
    //       trailing newline is emitted instead of being silently swallowed.
    // `parseAndEmitChunk` already skips blank lines, so the extra "\n" never
    // produces a phantom emission when the file already ended with one.
    // -----------------------------------------------------------------------
    try {
      const chunk = readBytesFrom(filePath, hwm);
      if (chunk || inheritedPriorLineBuffer.length > 0) {
        const flushChunk = chunk
          ? Buffer.concat([chunk, Buffer.from("\n")])
          : Buffer.from("\n");
        parseAndEmitChunk(flushChunk, {
          phaseState,
          priorLineBuffer: inheritedPriorLineBuffer,
          telemetryEmitter,
          traceContext,
          lineNumberBase: inheritedLineNumberBase,
        });
      }
    } catch (err) {
      // Catch-up read failed — emit a warning but continue to orphan pass.
      try {
        telemetryEmitter.emit({
          severity: "warn",
          category: "loop.perf.parse_failure",
          message: "perf.jsonl reconciliation catch-up read error",
          trace: traceContext,
          diagnostics: {
            loopPerf: {
              event: "parse_failure",
              lineNumber: 0,
              rawBytes: "",
              errorMessage: sanitizeLoopPerfErrorMessage(
                err instanceof Error ? err.message : String(err)
              ),
            },
          },
        });
      } catch {
        // Swallow.
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Walk .tool-calls/ for orphaned sentinel files.
    // -----------------------------------------------------------------------
    const toolCallsDir = path.join(workdir, ".tool-calls");
    let sentinelFiles: string[] = [];
    try {
      if (existsSync(toolCallsDir)) {
        sentinelFiles = readdirSync(toolCallsDir);
      }
    } catch {
      // Cannot read directory; skip orphan pass.
      sentinelFiles = [];
    }

    for (const fileName of sentinelFiles) {
      // Skip sentinels that pre-dated this run — they belong to whatever loop
      // (or process) wrote them on a reused workdir, not the command we just
      // finished reconciling.
      if (inheritedToolCallsBaseline.has(fileName)) {
        continue;
      }
      const sentinelFilePath = path.join(toolCallsDir, fileName);
      try {
        const raw = readFileSync(sentinelFilePath, "utf-8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Not valid JSON — skip this sentinel file.
          continue;
        }

        const result = sentinelSchema.safeParse(parsed);
        if (!result.success) {
          // Sentinel does not match expected schema — skip.
          continue;
        }

        const sentinel = result.data;

        // Emit one loop.perf.tool event for the orphaned tool call.
        // `endedAt`, `durationS`, `ok` are explicit `null` here — that is the
        // documented sentinel value for "tool started but never completed".
        // `command` is omitted when the sentinel didn't carry one, and
        // `phase` is omitted entirely (no phase observed for orphans, and the
        // diagnostics contract treats missing phase as "absent" rather than
        // null).
        const diagPayload: LoopPerfEventDiagnostics = {
          event: "tool",
          runId: sentinel.run_id,
          agentId: sentinel.agent_id,
          toolName: sentinel.tool_name,
          startedAt: sentinel.started_at,
          iteration: sentinel.iteration,
          ...loopPerfCommandProjection(sentinel.command),
          endedAt: null,
          durationS: null,
          ok: null,
        };

        telemetryEmitter.emit({
          severity: "info",
          category: "loop.perf.tool",
          message: "loop perf: tool (orphaned sentinel)",
          trace: traceContext,
          diagnostics: {
            loopPerf: diagPayload,
          },
        });
      } catch {
        // Silently skip unreadable or malformed sentinel files.
      }
    }
  } catch (err) {
    // Top-level catch — emit a warning and return.
    try {
      telemetryEmitter.emit({
        severity: "warn",
        category: "loop.perf.parse_failure",
        message: "perf.jsonl reconciliation error",
        trace: traceContext,
        diagnostics: {
          loopPerf: {
            event: "parse_failure",
            lineNumber: 0,
            rawBytes: "",
            errorMessage: sanitizeLoopPerfErrorMessage(
              err instanceof Error ? err.message : String(err)
            ),
          },
        },
      });
    } catch {
      // Swallow.
    }
  }
}
