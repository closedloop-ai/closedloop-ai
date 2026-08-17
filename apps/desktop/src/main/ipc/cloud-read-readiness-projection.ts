/**
 * @file cloud-read-readiness-projection.ts
 * @description ISS-6206 (wongk review on #5050): the main process's readiness
 * projection, as a pure factory over three getters rather than a closure buried
 * in the composition root.
 *
 * WHY IT LIVES HERE. The projection is the only place the app decides which
 * lanes are permanently unattestable for THIS install, and
 * `cloudReadLaneReadinessIsFinal` lets a startup surface stop waiting on a lane
 * that carries a reason. Read the settings answer wrong — bind a literal, read a
 * stale copy, drop the getter — and every install reports the transcript lane as
 * `disabled_by_config` even for a user who has transcript sync ON, so the
 * startup panel dismisses on a lane genuinely in play.
 *
 * Inside `desktop-ipc-registration.ts` that decision could only be reached by
 * booting Electron, so the wiring test could assert the SHAPE of the call and
 * nothing about its answer: replacing `getTranscriptSyncEnabled()` with the
 * literal `false` left the whole suite green. Two pieces had to move for that to
 * stop being true — the projection's RULES (this factory, which a node test
 * drives with synthetic getters) and the BINDING of each getter to a store
 * ({@link buildCloudReadReadinessProjectorDeps}, which a node test drives with a
 * fake settings store). Moving only the first left the mutation alive, since a
 * test supplying its own getters cannot observe where the shipped app's come
 * from.
 *
 * Every getter is read on each call, never captured, so flipping a setting is
 * reflected on the very next projection rather than at the next app launch.
 */

import { cloudReadLaneNotApplicableReason } from "../../shared/cloud-read-lane-applicability.js";
import type { CloudReadReadinessSnapshot } from "../../shared/cloud-read-readiness-contract.js";
import { projectCloudReadReadiness } from "../../shared/cloud-read-readiness-contract.js";
import type { SyncBurndownSnapshot } from "../../shared/sync-burndown-contract.js";

/** The live answers a projection needs, each read fresh on every call. */
export type CloudReadReadinessProjectionDeps = {
  /** `RendererReadinessGates.isInitialCollectorImportComplete`. */
  isImportComplete: () => boolean;
  /** The ISS-5387 burn-down's latest sample, or `null` before the first one. */
  getLatestSnapshot: () => SyncBurndownSnapshot | null;
  /** This app's persisted `transcriptSyncEnabled` switch. */
  getTranscriptSyncEnabled: () => boolean;
};

/**
 * The `getCloudReadReadiness` handler body. A `null` sample projects to an
 * explicitly UNKNOWN snapshot — never a drained one.
 */
export function createCloudReadReadinessProjector(
  deps: CloudReadReadinessProjectionDeps
): () => CloudReadReadinessSnapshot {
  return () =>
    projectCloudReadReadiness({
      importComplete: deps.isImportComplete(),
      snapshot: deps.getLatestSnapshot(),
      // ISS-6206 (shafty023 review on #5050): the CONFIGURATION answer for each
      // lane, read fresh on every projection so flipping the setting is
      // reflected on the next sample. A stopped sample can never supply this —
      // see `cloud-read-lane-applicability.ts`.
      notApplicableReason: (lane) =>
        cloudReadLaneNotApplicableReason(lane, {
          transcriptSyncEnabled: deps.getTranscriptSyncEnabled(),
        }),
    });
}

/**
 * The composition root's stores, narrowed to the members a projection reads.
 *
 * Structural rather than the concrete `SettingsStore` / `RendererReadinessGates`
 * / `SyncBurndownReporter` types so this module stays importable from a plain
 * node:test — those types drag in the main-process modules whose evaluation this
 * whole file exists to stay out of.
 */
export type CloudReadReadinessProjectionSources = {
  rendererGates: { isInitialCollectorImportComplete: () => boolean };
  syncBurndownReporter: {
    getLatestSnapshot: () => SyncBurndownSnapshot | null;
  };
  settingsStore: { getTranscriptSyncEnabled: () => boolean };
};

/**
 * Bind the projection's three getters to the composition root's stores.
 *
 * WHY THIS IS A FUNCTION AND NOT AN OBJECT LITERAL AT THE CALL SITE. Extracting
 * `createCloudReadReadinessProjector` moved the projection's RULES somewhere a
 * node test could execute them, but left the BINDING — which store each getter
 * actually reads — in `desktop-ipc-registration.ts`, reachable only by booting
 * Electron. `cloud-read-readiness-projection.test.ts` injects its own getters,
 * so it could not see that binding either, and the wiring guard could only read
 * the property NAMES off the literal. Both mutations that matter therefore
 * survived every suite: `getTranscriptSyncEnabled: () => false`, and the frozen
 * variant `const enabled = deps.settingsStore.getTranscriptSyncEnabled()`
 * captured once at boot and returned from a thunk. Each ships an install that
 * reports the transcript lane `disabled_by_config` for a user who has transcript
 * sync ON (or stuck at whatever it was at launch), so
 * `cloudReadLaneReadinessIsFinal` answers `true` and the startup panel dismisses
 * on a lane genuinely in play.
 *
 * As a function the binding is an executed decision:
 * `test/cloud-read-readiness-projection.test.ts` hands it a fake settings store,
 * flips the answer between projections, and watches the projected lane follow.
 * What remains in the composition root is `(deps)`.
 */
export function buildCloudReadReadinessProjectorDeps(
  sources: CloudReadReadinessProjectionSources
): CloudReadReadinessProjectionDeps {
  return {
    isImportComplete: () =>
      sources.rendererGates.isInitialCollectorImportComplete(),
    getLatestSnapshot: () => sources.syncBurndownReporter.getLatestSnapshot(),
    getTranscriptSyncEnabled: () =>
      sources.settingsStore.getTranscriptSyncEnabled(),
  };
}
