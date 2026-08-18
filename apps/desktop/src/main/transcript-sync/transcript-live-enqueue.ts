/**
 * @file transcript-live-enqueue.ts
 * @description The archive lane's LIVE triggers — everything that enqueues a
 * transcript ahead of the 30-min discovery sweep.
 *
 * Split out of `transcript-sync-service.ts`. Two live-capture channels feed it
 * (the Claude hook listener and the file watcher — see the collection-mode SSOT
 * in `collectors/engine/collection-mode.ts`), and the whole point of FEA-3640 is
 * that they share ONE cadence rather than defining it per collector. This module
 * owns the debounce-timer map that makes that true, so the two entry points
 * cannot drift onto separate schedules.
 */

import {
  type LiveActivityArm,
  planLiveActivityArms,
  type TranscriptLiveActivity,
} from "./transcript-live-activity.js";
import type { TranscriptObserveDeps } from "./transcript-observe.js";
import { enqueueChangedClaudeSidecars } from "./transcript-sidecar-sweep.js";
import type {
  Scheduler,
  TimerHandle,
  TranscriptHookPayload,
  TranscriptSyncServiceOptions,
} from "./transcript-sync-options.js";
import type { TranscriptFileRef } from "./transcript-sync-types.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS,
  TranscriptSourceHarness,
  toRawTranscriptSourceHarness,
  transcriptQueueKey,
} from "./transcript-sync-types.js";

/**
 * The Claude hook fired when ONE subagent finishes — the moment its sidecar
 * transcript is final, and so the only terminal event that needs to sweep the
 * session's sidecars (ISS-4390).
 */
const SUBAGENT_STOP_HOOK_TYPE = "SubagentStop";

/** Terminal Claude hook events that flush a transcript immediately. */
const TERMINAL_HOOK_TYPES = new Set([
  "Stop",
  "SessionEnd",
  SUBAGENT_STOP_HOOK_TYPE,
]);

export type TranscriptLiveEnqueueDeps = {
  opts: TranscriptSyncServiceOptions;
  scheduler: Scheduler;
  observe: TranscriptObserveDeps;
  /** PRD-532 §7 consent gate — see `TranscriptSyncService.tierAllowsSync`. */
  tierAllowsSync: () => boolean;
  log: (message: string) => void;
  /** Fire-and-forget a self-contained async task, logging any stray rejection. */
  runDetached: (work: Promise<unknown>) => void;
  /** Observe one ref as `live` and drain, honoring the consent tier. */
  enqueueAndDrain: (ref: TranscriptFileRef) => Promise<void>;
  drainOnce: () => Promise<void>;
};

export class TranscriptLiveEnqueue {
  private readonly debounceTimers = new Map<string, TimerHandle>();
  private readonly deps: TranscriptLiveEnqueueDeps;

  constructor(deps: TranscriptLiveEnqueueDeps) {
    this.deps = deps;
  }

  /** Tear down every armed timer (service `stop()`). */
  stop(): void {
    for (const handle of this.debounceTimers.values()) {
      this.deps.scheduler.clearTimeout(handle);
    }
    this.debounceTimers.clear();
  }

  /**
   * Hook-driven enqueue for a Claude session's MAIN transcript. Terminal events
   * flush immediately; activity events schedule a single ~5 min max-wait timer
   * (not reset by later activity) so continuous sessions upload on a steady
   * cadence.
   *
   * ISS-4390: `SubagentStop` additionally sweeps this session's subagent
   * sidecars for new bytes (see `transcript-sidecar-sweep.ts`).
   * `Stop`/`SessionEnd` deliberately do NOT — every sidecar gets its own
   * `SubagentStop` when it completes, and those hooks fire once per turn, so
   * sweeping on them too would re-stat the whole sidecar set every turn for no
   * new coverage.
   *
   * DORMANT IN CURRENT PRODUCTION: `CLAUDE_LIVE_HOOK_ENABLED` is hardcoded false
   * (FEA-3729), and the listener drops every Claude hook payload before it can
   * reach `onTranscriptHookEvent`, so nothing calls this method today — Claude
   * runs on the WATCHER, which is covered by {@link enqueueActivity} instead.
   * This path is written and tested against the day that kill switch flips; it
   * is not a live code path now.
   */
  enqueueClaudeHook(payload: TranscriptHookPayload): void {
    const { opts } = this.deps;
    if (!(opts.isEnabled() && payload.sessionId && payload.transcriptPath)) {
      return;
    }
    const candidate = payload.transcriptPath;
    const sessionId = payload.sessionId;
    // The hook listener is an unauthenticated localhost endpoint, so the path is
    // attacker-influenceable. Resolve it to a canonical real path under the known
    // transcript root before it can drive an archive byte upload of an arbitrary
    // readable file; enqueue that resolved path (not the original candidate) so a
    // symlink can't be repointed at a secret between this check and the upload.
    const trustedPath = opts.resolveTrustedTranscriptPath(candidate);
    // FEA-3464: Claude Code emits the hook at `SessionStart` and the first
    // `UserPromptSubmit` BEFORE the `<uuid>.jsonl` is flushed to disk, so the
    // anchor rejects a benign race. Distinguish that (skip / retry silently) from
    // a genuinely out-of-root path (log + reject NOW). A path resolving OUTSIDE
    // every trusted root is a real rejection and must not arm a retry timer, so
    // this immediate check preserves the pre-FEA-3464 reject-and-log behavior for
    // untrusted paths and only DEFERS the benign, still-under-root race.
    if (trustedPath === null && !this.isPendingTranscriptPath(candidate)) {
      this.deps.log(
        `transcript hook rejected untrusted path: ${payload.hookType}`
      );
      return;
    }
    if (TERMINAL_HOOK_TYPES.has(payload.hookType)) {
      this.flushTerminalHook(payload.hookType, sessionId, trustedPath);
      return;
    }
    // Activity: ride the shared cadence every harness uses (FEA-3640).
    this.armActivityDebounce(sessionId, TranscriptSourceHarness.Claude, {
      debounceKeySuffix: TRANSCRIPT_MAIN_FILE_KEY,
      candidatePath: candidate,
      childOfSourcePath: null,
    });
  }

  /**
   * Immediate flush for a terminal hook. Only enqueues an already-resolved path:
   * a pending race (`trustedPath === null`) has no file to flush yet, and must
   * NOT clear an armed activity debounce — its re-resolve is the ~5 min fast
   * retry that catches the file once flushed, so clearing it here would drop
   * that hook onto the 30-min discovery sweep instead.
   */
  private flushTerminalHook(
    hookType: string,
    sessionId: string,
    trustedPath: string | null
  ): void {
    if (trustedPath === null) {
      return;
    }
    // ISS-4390: clears the MAIN key only. A child's armed timer is left
    // running on purpose — it fires within the debounce window and flushes
    // that child itself, whereas tearing it down here would drop the child
    // onto the 30-min sweep, which is the exact lag this issue fixes.
    this.clearDebounce(transcriptQueueKey(sessionId, TRANSCRIPT_MAIN_FILE_KEY));
    this.deps.runDetached(
      this.deps.enqueueAndDrain({
        externalSessionId: sessionId,
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        sourceHarness: TranscriptSourceHarness.Claude,
        sourcePath: trustedPath,
      })
    );
    // ISS-4390 slice 2: on a hooks-installed install Claude's watcher never
    // runs, so this channel is the ONLY live path — and the payload names
    // the parent transcript, never the sidecar that just finished. Sweep
    // this session's sidecars for new bytes instead.
    //
    // Scoped to SubagentStop: that is precisely "a subagent finished, so its
    // sidecar is final". `Stop` fires once per TURN, so sweeping there would
    // re-stat every sidecar in the session on every turn — O(turns ×
    // sidecars) — to find work that SubagentStop already reported.
    if (hookType === SUBAGENT_STOP_HOOK_TYPE) {
      this.deps.runDetached(
        enqueueChangedClaudeSidecars(this.deps, sessionId, trustedPath)
      );
    }
  }

  /**
   * Harness-agnostic live-activity trigger for a session's MAIN transcript
   * (FEA-3640). The Claude HOOK channel and the file-WATCHER channel are two
   * different live-capture inputs by design (the collection-mode SSOT), but the
   * upload cadence must not be: before this, only the Claude hook armed the
   * ~5 min flush, so every watcher-mode harness (Codex especially) reached the
   * cloud solely via the 30-min discovery sweep. Both channels now land on the
   * same {@link armActivityDebounce}, so the cadence is defined once instead of
   * per collector.
   *
   * Ignores a harness whose raw transcript cannot be enqueued from a single
   * changed path (see `toRawTranscriptSourceHarness`) — those stay on the
   * sweep rather than archiving the wrong bytes.
   */
  enqueueActivity(activity: TranscriptLiveActivity): void {
    if (
      !(
        this.deps.opts.isEnabled() &&
        activity.externalSessionId &&
        activity.sourcePath
      )
    ) {
      return;
    }
    const harness = toRawTranscriptSourceHarness(activity.harness);
    if (harness === null) {
      return;
    }
    // ISS-4390: one arm per file that actually changed, so a child/sidechain
    // transcript rides the same ~5 min cadence as `main` under its own
    // `subagent:{id}` ref instead of waiting for the 30-min sweep.
    for (const arm of planLiveActivityArms(activity)) {
      this.armActivityDebounce(activity.externalSessionId, harness, arm);
    }
  }

  /**
   * Arm the shared ~5 min max-wait activity debounce for ONE transcript file —
   * a session's `main`, or (ISS-4390) one of its child/sidechain transcripts.
   * MAX-WAIT, not trailing: an already-armed timer for this file is left alone,
   * so a continuously-active session uploads on a steady cadence instead of
   * being starved by its own activity. The path is re-resolved when the timer
   * FIRES so an early-session race (the transcript not yet flushed to disk)
   * still resolves; a still-unresolvable path is skipped and left to the
   * discovery sweep.
   *
   * Keyed per FILE, not per session, so a `main`-armed timer cannot swallow a
   * child's arm. `main` keeps its historical `(sessionId, "main")` key, which is
   * what keeps the hook and watcher channels sharing one timer for it.
   */
  private armActivityDebounce(
    externalSessionId: string,
    sourceHarness: TranscriptSourceHarness,
    arm: LiveActivityArm
  ): void {
    const key = transcriptQueueKey(externalSessionId, arm.debounceKeySuffix);
    if (this.debounceTimers.has(key)) {
      return;
    }
    const handle = this.deps.scheduler.setTimeout(() => {
      this.debounceTimers.delete(key);
      const resolved = this.deps.opts.resolveTrustedTranscriptPath(
        arm.candidatePath
      );
      if (resolved === null) {
        return;
      }
      this.deps.runDetached(
        this.enqueueArmedRef(externalSessionId, resolved, sourceHarness, arm)
      );
    }, TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS);
    this.debounceTimers.set(key, handle);
  }

  /**
   * Enqueue+drain one armed transcript at its guard-resolved real path. A `main`
   * arm enqueues directly; a CHILD arm first resolves its `subagent:{id}` key
   * through the injected resolver.
   *
   * A missing, throwing, or NULL-returning resolver drops the enqueue and leaves
   * the child to the discovery sweep. The null case matters as much as the other
   * two: `sourcePath` here is the CHILD's path, so falling back to
   * {@link TRANSCRIPT_MAIN_FILE_KEY} would file the child's bytes under the main
   * transcript's key and advance main's byte cursor over content that is not
   * main's — corrupting the session's main archive rather than merely
   * duplicating an object.
   */
  private async enqueueArmedRef(
    externalSessionId: string,
    sourcePath: string,
    sourceHarness: TranscriptSourceHarness,
    arm: LiveActivityArm
  ): Promise<void> {
    let fileKey = TRANSCRIPT_MAIN_FILE_KEY;
    if (arm.childOfSourcePath !== null) {
      const resolveLiveRef = this.deps.opts.resolveLiveRef;
      if (!resolveLiveRef) {
        return;
      }
      let resolvedKey: string | null;
      try {
        resolvedKey = await resolveLiveRef(
          sourceHarness,
          arm.childOfSourcePath,
          sourcePath
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log(`transcript child ref resolve failed: ${message}`);
        return;
      }
      if (resolvedKey === null) {
        this.deps.log(
          `transcript child ref unresolved: ${arm.debounceKeySuffix}`
        );
        return;
      }
      fileKey = resolvedKey;
    }
    await this.deps.enqueueAndDrain({
      externalSessionId,
      fileKey,
      sourceHarness,
      sourcePath,
    });
  }

  /**
   * True when a rejected (null-resolving) hook path is a benign not-yet-flushed
   * race rather than a genuinely untrusted path — see
   * `TranscriptSyncServiceOptions.isPendingTrustedTranscriptPath`. Defaults to
   * `false` (log every rejection) when the classifier is not wired.
   */
  private isPendingTranscriptPath(candidate: string): boolean {
    return this.deps.opts.isPendingTrustedTranscriptPath?.(candidate) ?? false;
  }

  private clearDebounce(key: string): void {
    const handle = this.debounceTimers.get(key);
    if (handle) {
      this.deps.scheduler.clearTimeout(handle);
      this.debounceTimers.delete(key);
    }
  }
}
