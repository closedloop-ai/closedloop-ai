import "server-only";

import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";

export const BATCH_TAG_REMOVE_UNRESOLVED_IDS_EVENT =
  "entity_tags_batch_remove_unresolved_ids";
export const BATCH_TAG_REMOVE_UNRESOLVED_IDS_REASON =
  "one or more ids did not resolve in the caller's organization";

const unresolvedIdsEvent = createThrottledMonitoredEvent();

/** Exposed for deterministic reset by the owning telemetry tests. */
export const batchTagRemoveUnresolvedIdsThrottle = unresolvedIdsEvent.throttle;

/** Reports a refused batch without exposing unresolved identities. */
export function reportUnresolvedBatchTagRemoveIds(
  organizationId: string,
  fields: {
    unresolvedIdCount: number;
    requestedIdCount: number;
  }
): void {
  unresolvedIdsEvent.report(
    organizationId,
    {
      event: BATCH_TAG_REMOVE_UNRESOLVED_IDS_EVENT,
      payload: {
        organizationId,
        reason: BATCH_TAG_REMOVE_UNRESOLVED_IDS_REASON,
      },
    },
    fields
  );
}
