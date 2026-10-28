/**
 * @file deployment-state.ts
 * @description ISS-9434: GitHub's `deployment_status.state` vocabulary — the
 * exact set of words a DEPLOYMENT artifact's freeform `artifacts.status` column
 * can hold.
 *
 * One symbol, two readers, nothing re-declared: `RecordDeploymentInput.state`
 * narrows to it so an arbitrary string can no longer reach the column, and the
 * audit cron's artifact-status conformance gauge uses it as the DEPLOYMENT
 * vocabulary.
 *
 * Lives beside the deployment writer rather than in `@repo/api`: both readers
 * are inside `apps/api`, and the root `AGENTS.md` reserves
 * `packages/api/src/types/` for types consumed by BOTH apps.
 *
 * The FULL provider set is declared even though today's only caller emits
 * `success` alone — it returns early on every other state. A one-member
 * vocabulary would read as correct right up until that early return is relaxed,
 * at which point the conformance gauge would report every real deployment state
 * as a violation. `deployment-state.test.ts` pins "full" to the spellings the
 * ISS-4975 normalizer mapped before ISS-12780 deleted it.
 */

export const DeploymentState = {
  Queued: "queued",
  Pending: "pending",
  Waiting: "waiting",
  InProgress: "in_progress",
  Success: "success",
  Failure: "failure",
  Error: "error",
  Inactive: "inactive",
} as const;
export type DeploymentState =
  (typeof DeploymentState)[keyof typeof DeploymentState];

export const DEPLOYMENT_STATE_OPTIONS = Object.values(DeploymentState);
