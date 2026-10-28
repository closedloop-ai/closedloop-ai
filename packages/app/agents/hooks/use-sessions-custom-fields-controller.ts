"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { SessionsCustomFieldsController } from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import { everySessionHasCustomFieldProjection } from "@repo/app/agents/lib/session-custom-field-operands";
import {
  type EntityListCustomFieldsItem,
  useEntityListCustomFieldsController,
} from "@repo/app/custom-fields/hooks/use-entity-list-custom-fields-controller";
import { useMemo } from "react";
import { agentSessionKeys } from "./agent-session-keys";

/**
 * The Sessions list's custom-field controller: the shared
 * `useEntityListCustomFieldsController` (ISS-12663) for Session artifacts,
 * adapted to the row-shaped contract the Sessions surface reads.
 */
export function useSessionsCustomFieldsController(
  items: readonly AgentSessionListItem[],
  options?: { enabled?: boolean }
): SessionsCustomFieldsController | undefined {
  const entityItems = useMemo(
    () => items.map(toEntityListCustomFieldsItem),
    [items]
  );
  const controller = useEntityListCustomFieldsController({
    enabled:
      (options?.enabled ?? true) && everySessionHasCustomFieldProjection(items),
    entityType: CustomFieldEntityType.Session,
    invalidateQueryKeys: SESSIONS_CUSTOM_FIELD_INVALIDATION_KEYS,
    items: entityItems,
  });
  return useMemo(() => {
    if (!controller) {
      return undefined;
    }
    const { onValueChange, searchReferenceTargets, valuesByEntityId, ...rest } =
      controller;
    return {
      ...rest,
      valuesBySessionId: valuesByEntityId,
      isValueWritable: (row) => valuesByEntityId.has(row.id),
      onValueChange: onValueChange
        ? (row, field, value) => {
            if (!valuesByEntityId.has(row.id)) {
              return;
            }
            return onValueChange(row.id, field, value);
          }
        : undefined,
      searchReferenceTargets: searchReferenceTargets
        ? (field, row, query) => searchReferenceTargets(field, row.id, query)
        : undefined,
    };
  }, [controller]);
}

/** Both Sessions list read shapes a value write changes. */
const SESSIONS_CUSTOM_FIELD_INVALIDATION_KEYS = [
  agentSessionKeys.lists(),
  agentSessionKeys.pageDataRoot(),
];

/**
 * Carries `customFields` only when the row has it, so the shared controller can
 * still tell an omitted projection from an empty one.
 */
function toEntityListCustomFieldsItem(
  item: AgentSessionListItem
): EntityListCustomFieldsItem {
  return Object.hasOwn(item, "customFields")
    ? { entityId: item.id, customFields: item.customFields }
    : { entityId: item.id };
}
