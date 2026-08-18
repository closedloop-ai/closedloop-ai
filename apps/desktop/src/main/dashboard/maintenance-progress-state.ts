// ISS-6241: the post-boot maintenance phase the renderer's first-launch splash
// surfaces, extracted from `agent-dashboard-design-system-runtime.ts` so the
// runtime keeps only the lifecycle it owns (generation counter, scheduling,
// settle semantics) and the published SHAPE lives with the rules that govern it.

import {
  isCountablePopulation,
  type MaintenanceCountlessPayload,
  MaintenancePhase,
  type MaintenanceProgressPayload,
  type MaintenanceRebuildPayload,
} from "../../shared/maintenance-progress-contract.js";
import { gatewayLog } from "../logging/gateway-logger.js";

/**
 * ISS-6241: the published shape IS the shared wire contract
 * (`shared/maintenance-progress-contract.ts`), which the renderer's boundary
 * validator derives its schema from. This name stays as the main-side alias its
 * callers already use; it must never become a second declaration, or a field
 * added here would compile while the validator silently stripped it.
 */
export type AgentDashboardMaintenanceProgress = MaintenanceProgressPayload;

/** The live maintenance phase plus the generation-guarded writers for it. */
export type MaintenanceProgressState = {
  read: () => AgentDashboardMaintenanceProgress;
  /**
   * Publish the active phase. Counts are dropped on every PUBLISH, not merely
   * on a change of phase, so the rebuild's population can never be re-rendered
   * under the artifact-link step (which does not measure the same thing, or
   * anything) and re-publishing the SAME phase is how a caller starting a fresh
   * attempt clears the previous attempt's numbers — see the re-drive in
   * `post-boot-maintenance.ts`.
   */
  setPhase: (generation: number, phase: MaintenancePhase) => void;
  /**
   * Publish counts for the phase already active. Ignored unless `phase` still
   * matches the phase that owns them, so a report that lands after the chain has
   * advanced cannot attach a stale population to the next step.
   *
   * Typed to the `rebuild` phase specifically: it is the only pass with a
   * progress channel, so the wire contract gives no other phase a place to put
   * counts and this signature refuses them at compile time rather than relying
   * on the runtime phase check alone.
   */
  setPhaseProgress: (
    generation: number,
    phase: typeof MaintenancePhase.Rebuild,
    progress: { processed: number; total: number }
  ) => void;
  clear: () => void;
};

/**
 * Injected so the invariant breach below is observable in the direct state tests
 * without reaching into the gateway's buffer. Defaults to the gateway's
 * structured log, which is the monitored main-process path.
 */
export type MaintenanceProgressStateDeps = {
  logInvariantViolation?: (message: string) => void;
};

/** Subsystem tag for the structured log entries emitted below. */
export const MAINTENANCE_PROGRESS_LOG_TAG = "maintenance-progress";

/**
 * Narrowing helper: `phase` is a union here, and neither member of the payload
 * union accepts a union-typed `phase`, so the assignment has to happen inside a
 * branch where it is a single literal.
 */
function livePhasePayload(
  phase: MaintenancePhase
): MaintenanceCountlessPayload | MaintenanceRebuildPayload {
  if (phase === MaintenancePhase.Rebuild) {
    return { active: true, phase };
  }
  return { active: true, phase };
}

/**
 * `isActive` is the runtime's generation guard: a superseded or closed
 * generation must not publish, or a cancelled maintenance window would leave the
 * banner reporting a pass that no longer owns the runtime.
 */
export function createMaintenanceProgressState(
  isActive: (generation: number) => boolean,
  deps: MaintenanceProgressStateDeps = {}
): MaintenanceProgressState {
  const logInvariantViolation =
    deps.logInvariantViolation ??
    ((message: string) =>
      gatewayLog.warn(MAINTENANCE_PROGRESS_LOG_TAG, message));
  let progress: AgentDashboardMaintenanceProgress = {
    active: false,
    phase: null,
  };
  return {
    read: () => progress,
    setPhase: (generation, phase) => {
      if (!isActive(generation)) {
        return;
      }
      progress = livePhasePayload(phase);
    },
    setPhaseProgress: (generation, phase, { processed, total }) => {
      if (!isActive(generation) || progress.phase !== phase) {
        return;
      }
      // shafty023 review: a report the producer cannot substantiate — a zero or
      // negative population, a fractional or non-finite count, or a numerator
      // that outruns its denominator — is REJECTED to the indeterminate state,
      // never coerced into a believable one. Clamping `101/100` to `100/100`
      // manufactured exactly the false completion this change exists to prevent,
      // and it did so silently. Dropping back to indeterminate also discards any
      // previously published counts: a producer that has just reported an
      // impossible population has forfeited its claim on this phase's numbers,
      // and continuing to show the last good pair would present a stale value as
      // current.
      if (!isCountablePopulation(processed, total)) {
        logInvariantViolation(
          `rejected uncountable ${phase} population to indeterminate: processed=${processed} total=${total}`
        );
        progress = { active: true, phase };
        return;
      }
      progress = { active: true, phase, processed, total };
    },
    clear: () => {
      progress = { active: false, phase: null };
    },
  };
}
