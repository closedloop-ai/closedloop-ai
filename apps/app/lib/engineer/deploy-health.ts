import type { DeployInfo } from "@/lib/engineer/deploy-tracker";

export const MountDeployHealthAction = {
  ClearDeployment: "clear_deployment",
  Noop: "noop",
  ResetFailure: "reset_failure",
} as const;

export type MountDeployHealthAction =
  (typeof MountDeployHealthAction)[keyof typeof MountDeployHealthAction];

type MountDeployHealthResponse = {
  alive: boolean;
};

/**
 * Maps the TicketList mount-time deploy health response to the existing local
 * deployment state mutation. Policy-denied Desktop responses are HTTP 200 with
 * `alive: false`, so they intentionally use the stale-deployment cleanup path.
 */
export function resolveMountDeployHealthAction(
  info: Pick<DeployInfo, "healthCheckFailed">,
  response: MountDeployHealthResponse
): MountDeployHealthAction {
  if (!response.alive) {
    return MountDeployHealthAction.ClearDeployment;
  }

  if (info.healthCheckFailed) {
    return MountDeployHealthAction.ResetFailure;
  }

  return MountDeployHealthAction.Noop;
}
