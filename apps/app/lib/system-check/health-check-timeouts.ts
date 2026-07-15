/** Maximum time a regular health-check fetch may block before timing out. */
export const PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS = 5000;

/** Maximum health-check wait when plugin auto-update remediation may run. */
export const PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS = 45_000;

/** Selects the health-check timeout for the request mutation mode. */
export function getPreLoopHealthCheckTimeoutMs(
  pluginAutoUpdateEnabled = false
): number {
  return pluginAutoUpdateEnabled
    ? PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS
    : PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS;
}
