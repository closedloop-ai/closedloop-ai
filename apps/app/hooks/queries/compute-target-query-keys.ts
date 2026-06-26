export const HEALTH_CHECK_AUTO_UPDATE_QUERY_SEGMENT =
  "plugin-auto-update" as const;
export const HEALTH_CHECK_NO_AUTO_UPDATE_QUERY_SEGMENT =
  "plugin-no-auto-update" as const;

/** Query keys for app-owned compute-target snapshots, health checks, and commands. */
export const computeTargetKeys = {
  all: ["compute-targets"] as const,
  list: () => [...computeTargetKeys.all, "list"] as const,
  healthCheck: (targetId: string) =>
    [...computeTargetKeys.all, targetId, "health-check"] as const,
  healthCheckMode: (targetId: string, pluginAutoUpdateEnabled: boolean) =>
    [
      ...computeTargetKeys.healthCheck(targetId),
      pluginAutoUpdateEnabled
        ? HEALTH_CHECK_AUTO_UPDATE_QUERY_SEGMENT
        : HEALTH_CHECK_NO_AUTO_UPDATE_QUERY_SEGMENT,
    ] as const,
  commandKeys: (targetId: string, commandId: string) =>
    [...computeTargetKeys.all, targetId, "commands", commandId] as const,
};
