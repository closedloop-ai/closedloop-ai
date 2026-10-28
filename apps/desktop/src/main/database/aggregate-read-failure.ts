import { isReadCancelledError } from "../../shared/read-cancellation-contract.js";
import { isTransientDbHostError } from "../../shared/transient-db-host-error.js";
import { ANALYTICS_AGGREGATE_UNAVAILABLE_MESSAGE } from "../agent-sync/agent-session-read-model.js";
import { LocalReadFailedRead } from "../telemetry/local-read-failed-diagnostics.js";
import { reportLocalReadFailed } from "../telemetry/local-read-failed-telemetry.js";
import { USAGE_AGGREGATE_UNAVAILABLE_MESSAGE } from "./session-usage-aggregate.js";

/** The local aggregate reads this boundary guards. */
export type AggregateRead =
  | typeof LocalReadFailedRead.UsageAggregate
  | typeof LocalReadFailedRead.AnalyticsAggregate;

const UNAVAILABLE_MESSAGE: Record<AggregateRead, string> = {
  [LocalReadFailedRead.UsageAggregate]: USAGE_AGGREGATE_UNAVAILABLE_MESSAGE,
  [LocalReadFailedRead.AnalyticsAggregate]:
    ANALYTICS_AGGREGATE_UNAVAILABLE_MESSAGE,
};

/**
 * The rejection a failed local aggregate read settles with. Cancellation
 * (ISS-9802) and db-host lifecycle failures (ISS-4483 / ISS-5808) come back
 * UNCHANGED, because both are positively classified downstream. Anything else is
 * logged to the store log beside the read that failed, handed to the monitored
 * telemetry reporter (ISS-11351, which owns what reports), and replaced by that
 * read's sanitized unavailable message so no driver text reaches the renderer.
 */
export function aggregateReadFailure(
  error: unknown,
  read: AggregateRead,
  log: (message: string) => void
): unknown {
  if (isReadCancelledError(error) || isTransientDbHostError(error)) {
    return error;
  }
  const unavailableMessage = UNAVAILABLE_MESSAGE[read];
  log(
    `${unavailableMessage}: ${error instanceof Error ? error.message : String(error)}`
  );
  reportLocalReadFailed(read, error);
  return new Error(unavailableMessage);
}
