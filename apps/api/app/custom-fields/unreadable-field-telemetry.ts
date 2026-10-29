import "server-only";

import { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import { unknownEnumValueLine } from "@/lib/db-utils";
import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";

/**
 * ISS-11071: a custom field `GET /custom-fields` left out because its row holds
 * an enum value this build's Prisma client cannot map. Stable snake_case so a
 * monitor can key on it; `reason` reuses the sort/filter path's
 * `custom_field_type_unsupported` code rather than minting a second one.
 */
export const CUSTOM_FIELD_UNREADABLE_OMITTED_EVENT =
  "custom_field_unreadable_omitted";

/**
 * Every list read re-reads the same persisted row, so a polling client would
 * otherwise emit per request (`apps/api/AGENTS.md` "Emission and Abuse
 * Control"). Keyed per field so a second unreadable field in the same org is
 * still named; the keyspace is bounded by the org's field cap and the
 * throttle's LRU. `drainExpired` is not wired: the first occurrence per key
 * always emits, so a suppressed tail can stay unflushed and a summed
 * `occurrences` is a lower bound, not an exact count.
 */
const unreadableFieldEvent = createThrottledMonitoredEvent();

/** Exported so tests can `clear()` it; production code must not reach in. */
export const customFieldUnreadableThrottle = unreadableFieldEvent.throttle;

export function reportUnreadableCustomField(
  organizationId: string,
  customFieldId: string,
  error: Error
): void {
  unreadableFieldEvent.report(
    `${organizationId}|${customFieldId}`,
    {
      event: CUSTOM_FIELD_UNREADABLE_OMITTED_EVENT,
      payload: {
        organizationId,
        customFieldId,
        reason: CustomFieldQueryRejection.UnsupportedFieldType,
      },
    },
    { enumReadError: unknownEnumValueLine(error) }
  );
}
