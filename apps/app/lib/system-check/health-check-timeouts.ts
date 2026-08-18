/**
 * Health-check budgets. The pre-loop check forks on `relayTargetId`
 * (`buildHealthCheckRequest`): a `null` target hits the loopback gateway on the
 * same machine, while a non-null target traverses browser -> app -> relay socket
 * -> Electron gateway -> process spawn -> response. Those are different orders of
 * magnitude, so the budget forks with the request instead of applying one flat
 * localhost number to both (ISS-5169).
 */

/** Maximum time a loopback-gateway health-check fetch may block. */
export const PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS = 5000;

/** Maximum time a relay-targeted health-check fetch may block, per attempt. */
export const PRE_LOOP_RELAY_HEALTH_CHECK_TIMEOUT_MS = 20_000;

/** Maximum health-check wait when plugin auto-update remediation may run. */
export const PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS = 45_000;

/**
 * Attempts a relay-targeted health check gets before the gate gives up. One slow
 * round trip over the relay is a transient, not a verdict, so the query retries
 * once on a transport/timeout failure rather than hard-blocking the operator's
 * command (ISS-5169).
 */
export const PRE_LOOP_RELAY_HEALTH_CHECK_MAX_ATTEMPTS = 2;

/** Attempts a loopback-gateway health check gets. Localhost does not flake. */
export const PRE_LOOP_LOCAL_HEALTH_CHECK_MAX_ATTEMPTS = 1;

/**
 * Slack added to the caller-side backstop so the per-attempt abort always wins
 * the race. Without it the two timeouts are effectively simultaneous and the
 * operator gets whichever opaque reason fires first.
 */
export const PRE_LOOP_HEALTH_CHECK_OVERALL_TIMEOUT_GRACE_MS = 2000;

export type HealthCheckTimeoutScope = {
  pluginAutoUpdateEnabled?: boolean;
  /** True when the request is routed through the relay to a compute target. */
  relayTarget?: boolean;
};

/** Selects the per-attempt health-check timeout for a request scope. */
export function getPreLoopHealthCheckTimeoutMs({
  pluginAutoUpdateEnabled = false,
  relayTarget = false,
}: HealthCheckTimeoutScope = {}): number {
  if (pluginAutoUpdateEnabled) {
    return PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS;
  }
  return relayTarget
    ? PRE_LOOP_RELAY_HEALTH_CHECK_TIMEOUT_MS
    : PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS;
}

/** Selects how many attempts a health check gets for a request scope. */
export function getPreLoopHealthCheckMaxAttempts({
  pluginAutoUpdateEnabled = false,
  relayTarget = false,
}: HealthCheckTimeoutScope = {}): number {
  // Plugin auto-update remediation mutates the target; never replay it.
  if (pluginAutoUpdateEnabled || !relayTarget) {
    return PRE_LOOP_LOCAL_HEALTH_CHECK_MAX_ATTEMPTS;
  }
  return PRE_LOOP_RELAY_HEALTH_CHECK_MAX_ATTEMPTS;
}

/**
 * Budget for the caller-side backstop that wraps the whole query, including
 * retries. Strictly larger than one attempt so the per-attempt abort reports the
 * specific failure and this wrapper stays a true last-resort guard.
 */
export function getPreLoopHealthCheckOverallTimeoutMs(
  scope: HealthCheckTimeoutScope = {}
): number {
  return (
    getPreLoopHealthCheckTimeoutMs(scope) *
      getPreLoopHealthCheckMaxAttempts(scope) +
    PRE_LOOP_HEALTH_CHECK_OVERALL_TIMEOUT_GRACE_MS
  );
}
