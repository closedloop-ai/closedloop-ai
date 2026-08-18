/**
 * @file transcript-live-activity.ts
 * @description ISS-4390: the harness-agnostic PLANNING half of the transcript
 * lane's live-activity trigger — given one watcher activity report, decide which
 * transcript files should arm the shared ~5 min flush.
 *
 * Split out of `transcript-sync-service.ts` (which owns the timers, the trust
 * guard, and the queue) so the decision is a pure function with no scheduler,
 * store, or filesystem coupling, and to keep that service's growth in check
 * against the 1,000-LOGICAL-line ceiling (`noExcessiveLinesPerFile` counts code
 * lines, not the comment-heavy physical length).
 * Deliberately collector-free: the service static-imports this, and the
 * desktop boot graph may not statically reach `src/main/collectors/**` (the
 * agent-dashboard boundary). Resolving a child's final `subagent:{id}` key DOES
 * need collector knowledge, so that step lives in the lazily-imported
 * `live-transcript-ref-resolver.ts` and happens later, when the timer fires.
 */
import path from "node:path";
import { TRANSCRIPT_MAIN_FILE_KEY } from "./transcript-sync-types.js";

/**
 * One harness's live-watcher activity report. `sourcePath` is the collector's
 * MAPPED import source; `changedPaths` (ISS-4390) are the original paths whose
 * bytes actually moved, which for a Codex child rollout or a Claude subagent
 * sidecar are NOT the mapped source. Absent `changedPaths` reproduces the
 * pre-ISS-4390 behavior exactly (arm `main` for the mapped source).
 */
export type TranscriptLiveActivity = {
  harness: string;
  externalSessionId: string;
  sourcePath: string;
  changedPaths?: readonly string[];
};

/** One file to arm a debounce for, produced by {@link planLiveActivityArms}. */
export type LiveActivityArm = {
  /**
   * Debounce-key suffix identifying this file WITHIN the session. `main` for the
   * session's main transcript; otherwise the resolved changed path, which is a
   * free 1:1 stand-in for file identity at arm time.
   *
   * Deliberately not the final `subagent:{id}` key: computing that for Codex
   * costs a rollout head-read, and arming happens on EVERY watcher event while
   * the flush fires at most once per file per debounce window. Paying it at arm
   * time would turn a rare read into a per-event one; the real key is resolved
   * when the timer fires. Either way one timer exists per file, which is what
   * stops a main-armed timer from swallowing a child's.
   */
  debounceKeySuffix: string;
  /** The path to trust-resolve and upload when the timer fires. */
  candidatePath: string;
  /**
   * The mapped root/parent source this file hangs off, or null when this arm IS
   * the main transcript. Non-null marks a child whose `subagent:{id}` key still
   * needs resolving.
   */
  childOfSourcePath: string | null;
};

/**
 * Decide which files one activity report should arm. A report carrying no
 * changed paths arms the mapped source as `main` (unchanged legacy behavior). A
 * report carrying changed paths arms exactly those — so a CHILD-ONLY change
 * arms only the child and never re-enqueues the untouched root, which was the
 * wasted no-op flush ISS-4390 describes.
 *
 * De-duplicated by key suffix: one watcher batch can report the same file more
 * than once, and two arms for one file would be a redundant enqueue.
 */
export function planLiveActivityArms(
  activity: TranscriptLiveActivity
): LiveActivityArm[] {
  const changedPaths = activity.changedPaths ?? [];
  if (changedPaths.length === 0) {
    return [
      {
        debounceKeySuffix: TRANSCRIPT_MAIN_FILE_KEY,
        candidatePath: activity.sourcePath,
        childOfSourcePath: null,
      },
    ];
  }
  const mappedSource = path.resolve(activity.sourcePath);
  const arms: LiveActivityArm[] = [];
  const seen = new Set<string>();
  for (const changedPath of changedPaths) {
    const isChild = path.resolve(changedPath) !== mappedSource;
    const debounceKeySuffix = isChild
      ? path.resolve(changedPath)
      : TRANSCRIPT_MAIN_FILE_KEY;
    if (seen.has(debounceKeySuffix)) {
      continue;
    }
    seen.add(debounceKeySuffix);
    arms.push({
      debounceKeySuffix,
      candidatePath: isChild ? changedPath : activity.sourcePath,
      childOfSourcePath: isChild ? activity.sourcePath : null,
    });
  }
  return arms;
}
