/**
 * @file transcript-sync-options.ts
 * @description The transcript archive lane's injected-dependency contract, its
 * timer seam, and the shapes it projects to the renderer (FEA-2715 / PLN-1288).
 *
 * Split out of `transcript-sync-service.ts`: the lane is assembled from several
 * collaborating modules (discovery sweep, drain queue, live enqueue) that all
 * read the same options bag, so the contract lives here rather than inside any
 * one of them. Declarations only — no behavior beyond {@link defaultScheduler}.
 */
import type { TranscriptEgressGate } from "../../shared/transcript-sync-status-contract.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import type { TranscriptSyncExecutor } from "./transcript-sync-executor.js";
import type {
  TranscriptFileRef,
  TranscriptFileStat,
  TranscriptSourceHarness,
} from "./transcript-sync-types.js";

export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * All timing is injected so the queue/backoff/debounce logic is unit-testable
 * without real timers.
 */
export type Scheduler = {
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export const defaultScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Sync status projected for the availability UI (FEA-2716/2717). */
// FEA-2715 / ISS-4719: the renderer-facing status projection lives in a
// node-free shared module so the main handler, the preload bridge, and the
// renderer `desktopApi` type can all import one canonical shape without pulling
// this node-dependent module into the renderer tsconfig. Re-exported here so the
// lane's existing importers keep their local reference.
export type {
  TranscriptSyncStatusCounts,
  TranscriptSyncStatusSnapshot,
} from "../../shared/transcript-sync-status-contract.js";

/** Minimal shape of a Claude hook payload the service consumes for triggers. */
export type TranscriptHookPayload = {
  hookType: string;
  sessionId?: string;
  transcriptPath?: string;
};

export type TranscriptSyncServiceOptions = {
  /** Null until the db-host runtime is ready; the service no-ops until then. */
  getStore: () => TranscriptSyncStore | null;
  /** Build the executor bound to a concrete store (cached per store identity). */
  buildExecutor: (store: TranscriptSyncStore) => TranscriptSyncExecutor;
  /**
   * Full-sweep discovery of every local transcript file. May be async so the
   * caller can lazy-`import()` the collector-backed discovery module (keeping it
   * off the desktop boot static-import graph — the agent-dashboard boundary).
   */
  discover: () => TranscriptFileRef[] | Promise<TranscriptFileRef[]>;
  /**
   * ISS-4390: resolve the archive-lane file key for a CHILD transcript (a Codex
   * descendant rollout, a Claude subagent sidecar) given the root/parent source
   * the collector mapped it to. Async + injected for the same reason `discover`
   * is: the real implementation reaches into collector modules, which the
   * desktop boot graph may not statically import.
   *
   * Returns null when the changed path cannot be identified as a child of the
   * mapped source. Unwired, throwing, or null all degrade to the pre-ISS-4390
   * behavior — the child is left to the 30-min discovery sweep rather than
   * archived under a guessed key.
   */
  resolveLiveRef?: (
    harness: TranscriptSourceHarness,
    mappedSourcePath: string,
    changedPath: string
  ) => Promise<string | null>;
  /**
   * ISS-4390 (slice 2): enumerate one Claude session's subagent sidecars as
   * `(fileKey, sourcePath)` pairs. The HOOK channel — the live path on any
   * hooks-installed install, where Claude's watcher never runs — gets the PARENT
   * transcript path on `SubagentStop` and never the sidecar's, so it enumerates
   * instead of resolving. Bounded to one session's `subagents/` tree.
   *
   * Async + injected for the same boundary reason as `resolveLiveRef`. Omitted
   * leaves sidecars to the discovery sweep (pre-ISS-4390 behavior).
   */
  listSubagentRefs?: (
    mainTranscriptPath: string
  ) => Promise<Array<{ fileKey: string; sourcePath: string }>>;
  /**
   * FEA-3932: regenerate batch-materialized harness projections (OpenCode) from
   * their foreign store BEFORE each discovery pass, so `discover` enumerates
   * fresh materialized files. Best-effort + revision-gated internally (an
   * unchanged `opencode.db` rewrites nothing). May be async: the desktop
   * implementation forks a `utilityProcess` and resolves when that pass settles
   * (ISS-5337). Omitted = no materialize step (Claude/Codex-only deployments,
   * tests).
   */
  materialize?: () => void | Promise<void>;
  /**
   * ISS-5337: cancel an in-flight {@link materialize} pass. Called from
   * `TranscriptSyncService.stop()` so a sweep parked on the out-of-process pass
   * settles inside the shutdown quiesce budget instead of running on past
   * teardown. Omitted when `materialize` is synchronous or absent.
   */
  stopMaterialize?: () => void;
  /**
   * FEA-3932: one-shot automatic dead-letter redrive run once on service start,
   * BEFORE the first sweep. Flips a harness's `dead` rows back to `queued` (see
   * `TranscriptSyncStore.redriveDeadLettered`) so sessions dead-lettered under a
   * prior build (e.g. before OpenCode materialization existed) get one automatic
   * retry once their source re-materializes. Returns the rows redriven for
   * logging. Omitted = no redrive.
   */
  redriveOnStart?: () => Promise<number>;
  /** Feature-flag gate — when false the service never runs (hard no-op). */
  isEnabled: () => boolean;
  /** Signed-in + relay-ready: uploads only proceed when true. */
  isOnline: () => boolean;
  /**
   * PRD-532 §7 consent gate for the transcript (full session detail) lane.
   * Returns whether the user's chosen `syncObservabilityTier` permits session
   * CONTENTS to leave the machine — only the `full` tier does. Omitted
   * (undefined) means "not gated" — today's behavior, so existing callers and
   * tests are unaffected. When provided and it returns anything other than
   * `Allowed` (tier `metadata`, `local`, not-yet-consented `null`, a denying
   * org policy, or a policy that has not resolved), `shouldRun()` returns false
   * and NO transcript upload occurs regardless of the other preconditions. See
   * `transcriptEgressGate` in `../agent-sync/sync-egress-gate.js`.
   *
   * ISS-5348: this is the tri-state gate, not a boolean, so the status snapshot
   * can tell a settled denial apart from the unresolved org-policy boot window.
   * Egress is unchanged — only `Allowed` drains, so an unresolved policy still
   * fails closed.
   */
  getCloudSyncTierGate?: () => TranscriptEgressGate;
  /**
   * The live compute target id (or null offline). Passed through to
   * `observe` so a file synced under a previous target re-queues after a
   * target switch. Optional: omitted disables the target-switch check.
   */
  getComputeTargetId?: () => string | null;
  /**
   * Guard for hook-supplied transcript paths — the hook listener is an
   * unauthenticated localhost endpoint, so a path MUST be validated (anchored
   * under the known transcript root) before it can drive an archive byte upload.
   * Returns the resolved REAL path (symlinks followed, canonicalized) to be
   * uploaded, or `null` to reject; the service enqueues that resolved path so
   * the executor never re-opens the original symlink (which could be repointed
   * at a secret between check and read). Required, not optional: a new call site
   * that forgets to wire it would otherwise silently allow uploading any file
   * readable by the process. Tests pass a trivial `(path) => path` and exercise
   * the real anchoring separately.
   */
  resolveTrustedTranscriptPath: (path: string) => string | null;
  /**
   * Companion classifier for a REJECTED (null-resolving) hook path: returns true
   * only when the candidate is a benign not-yet-flushed race — it WOULD live
   * under a trusted transcript root but the `<uuid>.jsonl` is not on disk yet
   * (Claude Code fires the hook at `SessionStart` / the first `UserPromptSubmit`
   * before creating the file) — versus a genuinely untrusted path that resolves
   * OUTSIDE every root. The benign race is skipped silently instead of logged as
   * an untrusted rejection (FEA-3464). NEVER authorizes an upload: the path is
   * still (re-)anchored through `resolveTrustedTranscriptPath` before a byte is
   * read. Optional — omitted defaults to "not pending", i.e. every rejection is
   * logged (the pre-FEA-3464 behavior).
   */
  isPendingTrustedTranscriptPath?: (path: string) => boolean;
  statFile: (path: string) => Promise<TranscriptFileStat | null>;
  now?: () => string;
  sourcePathHash?: (path: string) => string;
  log?: (message: string) => void;
  concurrency?: number;
  scheduler?: Scheduler;
};
