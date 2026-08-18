export type RunnerOutcomeKind =
  | "timed_out"
  | "launch_failed"
  | "signaled"
  | "completed";

export declare const RunnerOutcomeKind: {
  readonly TimedOut: "timed_out";
  readonly LaunchFailed: "launch_failed";
  readonly Signaled: "signaled";
  readonly Completed: "completed";
};

export declare const DRIFT_WARN_PERCENT: number;

export declare const DEFAULT_RUNNER_TIMEOUT_MS: number;

export type RunnerOutcome = {
  kind: RunnerOutcomeKind;
  messages: string[];
  exitCode: number;
  summaryLine: string;
  annotations: string[];
};

export declare function appendStepSummary(
  line: string,
  env?: NodeJS.ProcessEnv
): void;

export declare function classifyRunnerOutcome(input: {
  error?: { code?: string; message?: string } | undefined;
  signal?: string | null | undefined;
  status?: number | null | undefined;
  elapsedMs: number;
  runnerTimeoutMs: number;
}): RunnerOutcome;
