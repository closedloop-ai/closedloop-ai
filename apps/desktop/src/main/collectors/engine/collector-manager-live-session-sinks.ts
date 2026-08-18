/**
 * @file collector-manager-live-session-sinks.ts
 * @description Everything that happens to ONE session between parsing it and
 * writing it: stamping its import mode, and firing the two cross-subsystem sinks
 * that only a genuine LIVE-WATCHER import may arm. Extracted from
 * collector-manager.ts (grandfathered shrink-only under the root AGENTS.md
 * line-count contract) so this cohesive "annotate and notify" step owns its own
 * module and contract.
 *
 * The distinction the whole file turns on: `viaWatcher` is true for the startup
 * sweep and the catch-up poll as well as for real watcher events, so it is NOT
 * the live signal. `importMode` is — it is the existing SSOT for "a user is
 * driving this right now" — and both sinks below gate on it, not on `viaWatcher`.
 */
import type { captureInvocationDefinitionEvidence } from "../../packs/definition-content-collector.js";
import {
  type Harness,
  HarnessImportMode,
  type NormalizedSession,
} from "../types.js";

export type LiveSessionSinkOptions = {
  session: NormalizedSession;
  harness: Harness;
  /** The MAPPED import source (for a folded child, the parent). */
  source: string;
  viaWatcher: boolean;
  lowDutyImport: boolean;
  /**
   * Whether this import still belongs to the manager's current epoch. A
   * stop()/start() restart bumps the generation, and a stale import must not
   * report into the new epoch's sinks.
   */
  generationIsCurrent: boolean;
  /**
   * ISS-4390: the paths whose bytes actually changed behind `source`. For a
   * Codex child rollout or a Claude subagent sidecar the mapped source is the
   * unchanged root, whose byte-delta is a no-op, so the archive lane needs these
   * to reach the right file.
   */
  changedPaths: readonly string[] | undefined;
  onLiveTranscriptActivity?: (
    harness: Harness,
    externalSessionId: string,
    sourcePath: string,
    changedPaths?: readonly string[]
  ) => void;
  captureDefinitionEvidence: typeof captureInvocationDefinitionEvidence;
  log: (message: string) => void;
};

/**
 * Stamp the session's import mode and fire the live-only sinks. Returns the mode
 * it stamped.
 *
 * FEA-3640: ONLY a genuine live-watcher event arms the transcript lane's ~5 min
 * flush. Gating on `viaWatcher` alone would arm a timer for every historical
 * session and later observe the whole corpus as `live`, pushing a
 * freshly-imported backlog ahead of actual live work in the drain. The activity
 * sink is try/caught because it crosses into another subsystem and an import
 * must never fail on its account.
 */
export function applyLiveSessionSinks(
  options: LiveSessionSinkOptions
): HarnessImportMode {
  const { session, source } = options;
  const importMode =
    options.viaWatcher && !options.lowDutyImport
      ? HarnessImportMode.LiveWatcher
      : HarnessImportMode.Historical;
  session.importMode = importMode;
  if (importMode !== HarnessImportMode.LiveWatcher) {
    return importMode;
  }
  if (options.generationIsCurrent) {
    try {
      options.onLiveTranscriptActivity?.(
        options.harness,
        session.sessionId,
        source,
        options.changedPaths
      );
    } catch (error) {
      options.log(
        `transcript activity sink failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const definitionEvidence = options.captureDefinitionEvidence(session, {
    importMode,
  });
  if (definitionEvidence.length > 0) {
    session.invocationDefinitionEvidence = definitionEvidence;
  }
  return importMode;
}
