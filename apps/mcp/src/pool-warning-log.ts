import {
  type PoolWarning,
  setPoolWarningWriter,
} from "@repo/database/pool-telemetry";
import { log } from "@repo/observability/log";

/**
 * Ship `@repo/database`'s pool warnings (acquire timeout, telemetry sink
 * missing or failed) through the logger this process already sends to Datadog
 * (ISS-5853).
 *
 * Their default is `console.warn`, and on ECS stderr reaches CloudWatch only:
 * through 2026-09-22, `db_pool_telemetry.sink_missing` appeared in the mcp
 * service's CloudWatch log group and never in Datadog. So the acquire-timeout
 * line the pg pool-acquire timeout monitor matches on never arrived from mcp.
 * Imported by subpath so the suites that
 * `vi.mock("@repo/database")` do not have to mock this seam as well.
 */
export function routePoolWarningsToLog(): void {
  setPoolWarningWriter(writePoolWarningToLog);
}

/**
 * `level` and `status` are dropped because the logger stamps both itself; a
 * caller-supplied `status` would be moved aside to `callerStatus` and ride on
 * every record as noise.
 */
function writePoolWarningToLog({
  level: _level,
  status: _status,
  message,
  ...fields
}: PoolWarning): void {
  log.warn(message, fields);
}
