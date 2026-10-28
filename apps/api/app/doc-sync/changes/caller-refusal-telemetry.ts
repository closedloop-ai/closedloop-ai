import "server-only";

import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";
import type { DocSyncCallerRefusal } from "./verify-caller";

/**
 * Why `POST /doc-sync/changes` refused its caller. The 401 stays generic; this
 * is what separates an STS outage (`sts_unavailable`) or a misconfigured
 * `DOC_SYNC_CALLBACK_ROLE_ARN` (`wrong_role`) from a forged callback.
 */
export const DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT =
  "doc_sync.change_caller_refused";

/**
 * The route is unauthenticated, so any caller can drive a refusal per request
 * (`apps/api/AGENTS.md`, "Emission and Abuse Control"). Keyed on the reason
 * alone, a closed set of six, so one event per reason per window, the rest
 * counted into the rollup.
 */
const refusalEvent = createThrottledMonitoredEvent();

/** Exposed so tests can `clear()` it between cases. */
export const docSyncCallerRefusalThrottle = refusalEvent.throttle;

export function reportDocSyncCallerRefusal(reason: DocSyncCallerRefusal): void {
  refusalEvent.report(
    reason,
    { event: DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT, payload: { reason } },
    {}
  );
}
