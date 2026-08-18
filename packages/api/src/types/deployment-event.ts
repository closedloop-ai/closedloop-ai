/**
 * ISS-4975: contract for the append-only deployment-event history.
 *
 * Every provider status transition for a deployment — including failures — is
 * recorded as one immutable row. The mutable current-state DEPLOYMENT artifact
 * (+ `DeploymentDetail`) is unchanged and still answers "what is deployed right
 * now"; this history answers "what happened, and when", which is what the four
 * DORA metrics need:
 *
 * - deployment frequency  → count of distinct `externalDeploymentId` reaching
 *   `Success` inside a window
 * - lead time             → `occurredAt` minus the commit time for `sha`
 * - change-failure rate   → distinct deployments with a failure state divided by
 *   distinct deployments overall
 * - MTTR                  → per (repository, environment) series ordered by
 *   `occurredAt`, the gap from the first failure to the next `Success`
 *
 * Shared between `@repo/github` (which normalizes provider payloads) and
 * `apps/api` (which persists them), so it lives here rather than in either.
 */

/**
 * Event stream a history row was ingested from. Part of the dedupe identity so
 * two providers cannot collide on a raw numeric event id.
 */
export const DeploymentEventSource = {
  GitHub: "github",
} as const;
export type DeploymentEventSource =
  (typeof DeploymentEventSource)[keyof typeof DeploymentEventSource];

/**
 * Normalized deployment state. Provider vocabularies are mapped onto this set;
 * anything unrecognized degrades to `Unknown` and is still recorded, so a new
 * provider state can never silently drop an event from the history.
 */
export const DeploymentEventState = {
  Queued: "QUEUED",
  Pending: "PENDING",
  InProgress: "IN_PROGRESS",
  Success: "SUCCESS",
  Failure: "FAILURE",
  Error: "ERROR",
  Inactive: "INACTIVE",
  Unknown: "UNKNOWN",
} as const;
export type DeploymentEventState =
  (typeof DeploymentEventState)[keyof typeof DeploymentEventState];

/**
 * GitHub `deployment_status.state` vocabulary → normalized state.
 *
 * A `Map` rather than an object literal: the key is attacker-reachable webhook
 * input, and a plain-object lookup would resolve inherited keys such as
 * `constructor` or `__proto__` to a truthy non-state value.
 */
const PROVIDER_STATE_BY_NAME = new Map<string, DeploymentEventState>([
  ["queued", DeploymentEventState.Queued],
  ["pending", DeploymentEventState.Pending],
  ["waiting", DeploymentEventState.Pending],
  ["in_progress", DeploymentEventState.InProgress],
  ["success", DeploymentEventState.Success],
  ["failure", DeploymentEventState.Failure],
  ["error", DeploymentEventState.Error],
  ["inactive", DeploymentEventState.Inactive],
]);

/**
 * States that count as a completed, healthy deployment.
 */
const SUCCESS_STATES: ReadonlySet<DeploymentEventState> = new Set([
  DeploymentEventState.Success,
]);

/**
 * States that count as a failed deployment for change-failure rate and as the
 * start of an MTTR interval. `Inactive` is deliberately excluded: GitHub marks
 * superseded deployments inactive during a normal successful rollout.
 */
const FAILURE_STATES: ReadonlySet<DeploymentEventState> = new Set([
  DeploymentEventState.Failure,
  DeploymentEventState.Error,
]);

/**
 * Map a raw provider state string onto the normalized vocabulary.
 *
 * Unknown or absent states return `Unknown` rather than throwing — webhook
 * payloads are version-skewed and a state GitHub adds tomorrow must still be
 * ingested today.
 */
export function normalizeDeploymentEventState(
  providerState: string | null | undefined
): DeploymentEventState {
  if (!providerState) {
    return DeploymentEventState.Unknown;
  }
  return (
    PROVIDER_STATE_BY_NAME.get(providerState.trim().toLowerCase()) ??
    DeploymentEventState.Unknown
  );
}

/**
 * True when the state represents a deployment that completed successfully.
 */
export function isDeploymentSuccessState(state: DeploymentEventState): boolean {
  return SUCCESS_STATES.has(state);
}

/**
 * True when the state represents a failed deployment (change-failure numerator,
 * MTTR interval start).
 */
export function isDeploymentFailureState(state: DeploymentEventState): boolean {
  return FAILURE_STATES.has(state);
}

/**
 * True when the state ends a deployment attempt either way. `Unknown` is not
 * terminal — an unrecognized state carries no completion claim.
 */
export function isDeploymentTerminalState(
  state: DeploymentEventState
): boolean {
  return isDeploymentSuccessState(state) || isDeploymentFailureState(state);
}
