import {
  type ComputeTargetLinkBlockView,
  parseComputeTargetLinkBlock,
} from "../components/settings/compute-target-link-block-alert";
import {
  readRuntimeStatus,
  useRuntimeStatusValue,
} from "./use-runtime-status-poll";

/**
 * ISS-11426: project the compute-target link block out of the runtime-status
 * payload, or null when nothing is blocked.
 *
 * Declared at module level because {@link useRuntimeStatusValue} requires a
 * STABLE parser reference — an inline closure tears the shared poll's
 * subscription down and rebuilds it on every render.
 */
function parseLinkBlockFromRuntimeStatus(
  status: unknown
): ComputeTargetLinkBlockView | null {
  return parseComputeTargetLinkBlock(
    readRuntimeStatus(status).computeTargetLinkBlock
  );
}

/**
 * Polls the main-process link block while `active`, so the Settings alert
 * appears the moment the cloud starts refusing this machine and disappears on
 * the first accepted batch after a relink.
 *
 * The one-shot `runtime` snapshot this replaced could not do either: it is read
 * once at mount, and the block latches and clears at sync time. A tab left open
 * would never show a refusal that started after it mounted, and would keep
 * showing a stale alert to somebody who had already relinked — the UI lying
 * about state, on the one surface whose whole job is to report that state
 * (codex review). Same shared 1s poller as `useCloudSyncProgress` and
 * `useCloudSyncBacklog`, so this adds no `getRuntimeStatus` round-trip.
 */
export function useComputeTargetLinkBlock(
  active: boolean
): ComputeTargetLinkBlockView | null {
  return useRuntimeStatusValue(active, parseLinkBlockFromRuntimeStatus);
}
