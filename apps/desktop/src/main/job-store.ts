import Store from "electron-store";
import type { UserVisibleLoopFailurePayload } from "./user-visible-loop-failure.js";

export type LocalJobStatus =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "AWAITING_USER"
  | "STOPPED"
  | "CANCEL_PENDING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN"
  | "TIMED_OUT";

export type LocalJobKind = "SYMPHONY_LOOP";

export type LocalJobCommand =
  | "PLAN"
  | "EXECUTE"
  | "REQUEST_CHANGES"
  | "DECOMPOSE"
  | "GENERATE_PRD";

export type LocalJobCommitter = {
  name: string;
  email: string;
};

export type LocalJobFinalizationSource =
  | "live-exit"
  | "boot-recovery"
  | "heartbeat-terminal";

export type LocalJobExecuteFinalizationStatus =
  | "pending"
  | "success"
  | "no-changes"
  | "error"
  | "skipped";

export type LocalJobExecuteFinalizationPath =
  | "llm"
  | "git-fallback"
  | "artifact-existing"
  | "none";

export type TaskProgress = {
  pending: number;
  completed: number;
  total: number;
};

export type LocalJob = {
  id: string;
  kind: LocalJobKind;
  loopId: string;
  commandId?: string;
  operationId?: string;
  command: LocalJobCommand;
  ticketId?: string;
  artifactId?: string;
  artifactSlug?: string;
  issueId?: string;
  baseBranch?: string;
  /**
   * Primary repo `owner/name` from the loop request (`body.repo.fullName`).
   * Carried so boot-recovery finalization can populate the V2 envelope's
   * `fullName` field without depending on in-memory request state.
   */
  primaryRepoFullName?: string;
  webAppOrigin?: string;
  expectedMcpUrl?: string;
  committer?: LocalJobCommitter;
  repoPath?: string;
  localRepoPath?: string;
  worktreeDir?: string;
  claudeWorkDir?: string;
  /**
   * Loop-scoped S3 prefix assigned by symphony-alpha for failure support files.
   * Persisted so live finalization and boot recovery upload to the same scope.
   */
  s3StateKey?: string;
  /**
   * Additional-repo worktrees created for multi-repo PLAN/EXECUTE runs.
   * Persisted so boot recovery / finalizer can finalize their git work and
   * remove the worktrees after an Electron restart; in-process spawn logic
   * also tracks these locally for immediate finalization + cleanup on live
   * exits.
   *
   * `fullName` and `baseBranch` are optional for backward compatibility with
   * jobs persisted by older builds. When absent, recovery skips multi-repo
   * finalization (logs a warning) and falls through to worktree cleanup only.
   */
  additionalWorktreeDirs?: {
    dir: string;
    repoPath: string;
    fullName?: string;
    baseBranch?: string;
  }[];
  logPath?: string;
  jsonlPath?: string;
  statePath?: string;
  pid?: number;
  status: LocalJobStatus;
  phase?: string;
  liveActivity?: string;
  /** Trusted runner failure marker payload authenticated by the live parent process. */
  userVisibleLoopFailure?: UserVisibleLoopFailurePayload;
  currentTaskId?: string;
  taskProgress?: TaskProgress;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  warning?: string;
  exitCode?: number | null;
  /**
   * Replay-safe byte offset into `jsonlPath` (claude-output.jsonl).
   * Updated by the output tailer only after newline-delimited bytes are committed:
   * either summarized with no cloud `output` event, or after a successful (2xx) POST.
   */
  lastObservedJsonlOffset?: number;
  artifactsUploadedAt?: string;
  completedEventPostedAt?: string;
  /**
   * Set only after raw support files are uploaded and the cloud support event
   * is posted. Absence keeps recovery retries eligible after partial failures.
   */
  supportBundleUploadedAt?: string;
  finalStatusPersistedAt?: string;
  /** Set once cloud-side finalization is fully persisted. */
  cloudFinalizedAt?: string;
  /** Number of boot/live finalization attempts after local terminal persistence. */
  recoveryAttempts?: number;
  /** Last cloud finalization error for diagnostics and retry decisions. */
  lastRecoveryError?: string;
  finalizationSource?: LocalJobFinalizationSource;
  executeFinalizationStatus?: LocalJobExecuteFinalizationStatus;
  executeFinalizationPath?: LocalJobExecuteFinalizationPath;
  executeFinalizationStartedAt?: string;
  executeFinalizationCompletedAt?: string;
  executeFinalizationReason?: string;
  executeFinalizationPreExecutionResultPresent?: boolean;
  executeFinalizationPrePrBodyPresent?: boolean;
  executeFinalizationPostExecutionResultPresent?: boolean;
  executeFinalizationPostPrBodyPresent?: boolean;
  apiBaseUrl?: string;
};

const TERMINAL_STATUSES: ReadonlySet<LocalJobStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "STOPPED",
  "UNKNOWN",
  "TIMED_OUT",
]);

// T-1.1 design decision: a compile-time exhaustiveness guard
//   const _assertTimedOutIsTerminal: 'TIMED_OUT' extends (typeof TERMINAL_STATUSES extends ReadonlySet<infer S> ? S : never) ? true : never = true;
// was evaluated and found tautological. Because TERMINAL_STATUSES is declared as
// ReadonlySet<LocalJobStatus>, TypeScript widens the inferred element type to the
// full LocalJobStatus union — so the extends-check is always true regardless of the
// set's runtime contents. A membership assertion against a widened type provides no
// build-time safety. Runtime coverage for T-1.1 (AC-007) is provided by the
// isTerminalJobStatus('TIMED_OUT') assertion in job-store.test.ts.
export function isTerminalJobStatus(status: LocalJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const MAX_TERMINAL_JOBS = 100;

type JobStoreSchema = {
  activeJobs: LocalJob[];
  terminalJobs: LocalJob[];
};

export type JobStoreOptions = {
  cwd?: string;
  name?: string;
};

export class JobStore {
  private readonly store: Store<JobStoreSchema>;
  private readonly activeJobs: Map<string, LocalJob>;
  private terminalJobs: LocalJob[];

  constructor(options?: JobStoreOptions) {
    this.store = new Store<JobStoreSchema>({
      name: options?.name ?? "desktop-job-store",
      cwd: options?.cwd,
      defaults: {
        activeJobs: [],
        terminalJobs: [],
      },
    });

    const persistedActive = this.store.get("activeJobs", []);
    const persistedTerminal = this.store.get("terminalJobs", []);

    this.activeJobs = new Map(
      (Array.isArray(persistedActive) ? persistedActive : []).map((j) => [
        j.id,
        j,
      ])
    );
    this.terminalJobs = Array.isArray(persistedTerminal)
      ? persistedTerminal.slice(0, MAX_TERMINAL_JOBS)
      : [];
  }

  upsert(job: LocalJob): LocalJob {
    const isTerminal = TERMINAL_STATUSES.has(job.status);

    if (isTerminal) {
      // Move from active to terminal
      this.activeJobs.delete(job.id);

      // Prepend to terminal list, deduplicate, cap
      this.terminalJobs = [
        job,
        ...this.terminalJobs.filter((j) => j.id !== job.id),
      ].slice(0, MAX_TERMINAL_JOBS);
    } else {
      this.activeJobs.set(job.id, job);
    }

    this.persist();
    return job;
  }

  getById(id: string): LocalJob | undefined {
    return (
      this.activeJobs.get(id) ?? this.terminalJobs.find((j) => j.id === id)
    );
  }

  getByLoopId(loopId: string): LocalJob | undefined {
    for (const job of this.activeJobs.values()) {
      if (job.loopId === loopId) {
        return job;
      }
    }
    return this.terminalJobs.find((j) => j.loopId === loopId);
  }

  listRunning(): LocalJob[] {
    return [...this.activeJobs.values()];
  }

  listCompleted(): LocalJob[] {
    return [...this.terminalJobs];
  }

  /**
   * Reconcile persisted active jobs on startup.
   * Calls `checkLiveness(job)` for each active job to determine final state.
   * Returns jobs that were reconciled into terminal states.
   */
  reconcile(checkLiveness: (job: LocalJob) => LocalJob): LocalJob[] {
    const reconciled: LocalJob[] = [];

    for (const job of [...this.activeJobs.values()]) {
      const updated = checkLiveness(job);
      if (TERMINAL_STATUSES.has(updated.status)) {
        this.upsert(updated);
        reconciled.push(updated);
      } else if (updated !== job) {
        this.upsert(updated);
      }
    }

    return reconciled;
  }

  private persist(): void {
    this.store.set("activeJobs", [...this.activeJobs.values()]);
    this.store.set("terminalJobs", this.terminalJobs);
  }
}

/**
 * Returns an inert no-op `JobStore` for heartbeat callers that do not own a
 * real store (the one-shot sleep-resume probe and the legacy no-store launch
 * path). Every read returns empty and `upsert` echoes its argument, so
 * `runHeartbeatTick` finds no local job and skips finalization — leaving the
 * owning scheduler as the single actor responsible for terminalizing a job.
 *
 * Centralized here so the `as unknown as JobStore` escape hatch lives in one
 * place; if `JobStore` gains a method the heartbeat path begins to call, this
 * stub is the single spot to update.
 */
export function createStubJobStore(): JobStore {
  return {
    getByLoopId: () => undefined,
    getById: () => undefined,
    upsert: (j: LocalJob) => j,
    listRunning: () => [],
    listCompleted: () => [],
    reconcile: () => [],
  } as unknown as JobStore;
}
