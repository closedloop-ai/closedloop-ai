import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { customFieldValuesService } from "@/app/custom-fields/values-service";

export async function loadListCustomFieldValues(
  organizationId: string,
  sessionIds: readonly string[]
): Promise<Map<string, CustomFieldValueDetail[]> | null> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  try {
    const values = await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Session,
      [...sessionIds],
      organizationId
    );
    const valuesBySessionId = new Map<string, CustomFieldValueDetail[]>();
    for (const value of values) {
      const existing = valuesBySessionId.get(value.entityId);
      if (existing) {
        existing.push(value);
      } else {
        valuesBySessionId.set(value.entityId, [value]);
      }
    }
    return valuesBySessionId;
  } catch (error) {
    log.error(SESSIONS_LIST_CUSTOM_FIELD_READ_FAILED_EVENT, {
      organizationId,
      sessionCount: sessionIds.length,
      error: parseError(error),
    });
    return null;
  }
}

export const SESSIONS_LIST_CUSTOM_FIELD_READ_FAILED_EVENT =
  "sessions_list_custom_field_read_failed";
