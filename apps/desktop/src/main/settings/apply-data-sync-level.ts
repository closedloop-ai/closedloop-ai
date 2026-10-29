/**
 * @file The graduated data-sync level's application, lifted out of `app.ts`
 * (ISS-10950, under the shrink-only grandfather rule) with its behavior intact.
 *
 * It stayed one unit because the two halves are one decision: the SSOT write and
 * the in-memory reconciliation that has to agree with it, plus the transcript
 * lane that only exists once a level turns it on.
 */

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { dataSyncLevelToBooleans } from "../../shared/data-sync-level.js";

/**
 * The application's seams. All but one are a method `DesktopApplication`
 * already had; {@link ApplyDataSyncLevelDeps.onLevelRecorded} is the one this
 * lift adds.
 */
export type ApplyDataSyncLevelDeps = {
  isGoldenMode: () => boolean;
  isShuttingDown: () => boolean;
  /** Whether the transcript archive lane object exists this session. */
  hasTranscriptSyncLane: () => boolean;
  /** Construct and start it. Called at most once, guarded by the above. */
  startTranscriptSyncLane: () => void;
  /** Persist the level, its three connectivity booleans and the consent tier. */
  setDataSyncLevel: (level: DataSyncLevel) => void;
  setPersistedCloudConnectionEnabled: (enabled: boolean) => void;
  setCloudCommandsPaused: (paused: boolean) => void;
  setCloudConnectionEnabled: (enabled: boolean) => void;
  /** ISS-10950: a level pick records the consent that releases the boot import. */
  onLevelRecorded: () => void;
};

/**
 * FEA-3907 — apply a graduated data sync level: persist it as the SSOT (level
 * + derived booleans + tier via `settingsStore.setDataSyncLevel`) and reconcile
 * the in-memory connectivity state through the existing per-flag setters so the
 * cloud socket, tray, and presence side effects match a manual toggle. The
 * derived `cloudConnectionEnabled` / `cloudCommandsPaused` values drive
 * `setCloudConnectionEnabled` / `setCloudCommandsPaused`; the store write also
 * persists `transcriptSyncEnabled` and `syncObservabilityTier` for their own
 * consumers (TranscriptSyncService, the sync-tier gates).
 *
 * Golden mode (FEA-2648) hard-disables cloud egress and must never flip the
 * persisted or in-memory `cloudConnectionEnabled` to `true`. `setDataSyncLevel`
 * would persist `true` for any non-Off level, so in golden mode we force the
 * persisted connection flag back to `false` after the SSOT write, mirroring the
 * settings-IPC golden-mode guard (`buildNextUpdatePartial`). The in-memory
 * `setCloudConnectionEnabled` is already inert in golden mode.
 */
export function applyDataSyncLevel(
  level: DataSyncLevel,
  deps: ApplyDataSyncLevelDeps
): void {
  const derived = dataSyncLevelToBooleans(level);
  // SSOT write first: level + all four derived values land together so a crash
  // between the calls below can never leave the level and its flags disagreeing.
  deps.setDataSyncLevel(level);
  deps.onLevelRecorded();
  if (deps.isGoldenMode() && derived.cloudConnectionEnabled) {
    // Golden mode never enables cloud egress; keep the persisted connection
    // flag hard-disabled even though the level would otherwise turn it on.
    deps.setPersistedCloudConnectionEnabled(false);
  }
  // Reconcile in-memory state and socket/tray/presence bookkeeping. The SSOT
  // write above always persists policy, even when the connection setter skips
  // an already-enabled connection. Golden mode keeps that setter inert and
  // cloud egress hard-disabled, matching a manual toggle.
  deps.setCloudCommandsPaused(derived.cloudCommandsPaused);
  deps.setCloudConnectionEnabled(derived.cloudConnectionEnabled);
  reconcileTranscriptSyncLane(derived.transcriptSyncEnabled, deps);
}

/**
 * FEA-3907: the transcript lane is constructed once at boot from the
 * then-persisted `transcriptSyncEnabled` (FEA-2715, restart-scoped), so a level
 * that turns it on live would otherwise persist the flag but leave the lane
 * object `null` — silently no-op'ing the archive it claims to enable until the
 * next restart. Lazily construct + start it the first time a level enables the
 * lane this session so the choice takes effect immediately. Golden mode never
 * runs cloud egress, so the lane stays null there (matching the boot guard). We
 * never tear the lane down on a lower level: its own tick already no-ops when
 * `isEnabled()` (live `transcriptSyncEnabled`) goes false.
 */
function reconcileTranscriptSyncLane(
  transcriptSyncEnabled: boolean,
  deps: ApplyDataSyncLevelDeps
): void {
  const laneUnavailable =
    !transcriptSyncEnabled || deps.isGoldenMode() || deps.isShuttingDown();
  if (laneUnavailable || deps.hasTranscriptSyncLane()) {
    return;
  }
  deps.startTranscriptSyncLane();
}
