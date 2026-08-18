/** The harness abstraction: one uniform way to run a prompt through any engine. */
import type { HarnessName, NativeSchedule } from "../model.js";

export type RunOpts = {
  /** The instruction bundle to execute (harness-neutral). */
  prompt: string;
  /** Working directory the harness operates in. */
  cwd: string;
  /**
   * Model to drive this harness with (claude `--model`, codex `-m`, opencode
   * `--model`). Undefined ⇒ the driver falls back to its default model
   * (`DEFAULT_MODEL[name]`). Harness-neutral: each driver maps it to its own
   * flag.
   */
  model?: string;
  /** Extra directories the harness may read/write (claude --add-dir, codex --add-dir). */
  addDirs?: string[];
  /** Attached files; opencode gets `--file`, claude/codex get them inlined into stdin. */
  files?: string[];
  /** Hard wall-clock budget in ms. 0/undefined = unbounded. */
  timeoutMs?: number;
  /** ms after SIGTERM before SIGKILL on timeout. Default 120_000. */
  killAfterMs?: number;
  /** Sink for streamed stdout/stderr (e.g. append to a log file). */
  onOutput?: (chunk: string) => void;
  /** Extra env for the child. */
  env?: Record<string, string>;
  /** Cooperative cancel. */
  signal?: AbortSignal;
};

export type RunResult = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  /** Last ~4KB of combined output, for surfacing in a RunRecord. */
  outputTail: string;
};

export type HarnessCapabilities = {
  nativeSchedule: NativeSchedule;
  /**
   * Best-effort static list of models this harness can drive (the UI picker's
   * starting point, FEA-3855). First entry is the harness's default model.
   * Advisory, not an allow-list — a harness may accept models not listed here.
   */
  availableModels: readonly string[];
  /** The model used when a cascade step leaves `model` unset. */
  defaultModel: string;
};

export type Harness = {
  readonly name: HarnessName;
  readonly capabilities: HarnessCapabilities;
  /** True when the CLI is on PATH (best-effort). */
  isAvailable(): Promise<boolean>;
  /**
   * Best-effort enumeration of models this harness can drive, for the UI
   * picker. Defaults to the static `capabilities.availableModels`; a driver may
   * override to probe the live CLI. Never throws — returns the static list on
   * any probe failure.
   */
  listModels(): Promise<readonly string[]>;
  run(opts: RunOpts): Promise<RunResult>;
};
