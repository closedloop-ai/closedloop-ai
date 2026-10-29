"use client";

import type {
  CustomFieldEntityType,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { skipToken, useQuery } from "@tanstack/react-query";
import { customFieldKeys } from "./use-custom-fields";

export type ReadEntityCustomFieldValues = (
  entityId: string
) => Promise<readonly CustomFieldValueDetail[]>;

/**
 * One entity's custom-field values, under the key every value write
 * invalidates. Disabled while the host has no reader (desktop Local mode,
 * ISS-12302), so nothing is fetched there.
 */
export function useEntityCustomFieldValues({
  entityType,
  entityId,
  readValues,
}: {
  entityType: CustomFieldEntityType;
  entityId: string;
  readValues: ReadEntityCustomFieldValues | undefined;
}) {
  return useQuery({
    queryKey: customFieldKeys.values(entityType, entityId),
    queryFn: readValues ? () => readValues(entityId) : skipToken,
  });
}
