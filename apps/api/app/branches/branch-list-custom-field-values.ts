import type { BranchListResponse, BranchRow } from "@repo/api/src/types/branch";
import {
  CustomFieldEntityType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import {
  BranchListEnrichmentRead,
  reportBranchListEnrichmentFailedOpen,
} from "./branch-list-enrichment";

/**
 * ISS-12663: attach each Branch artifact's org custom-field values to its list
 * row, the projection the Sessions list already carries
 * (`agent-sessions/service/list-custom-field-values.ts`).
 *
 * Read AFTER the snapshot, on its own pooled query, so it can never abort the
 * list transaction. Best-effort: a failed read reports through the existing
 * failed-open enrichment event and returns the rows WITHOUT the field, which
 * the client reads as "values not loaded" rather than as "no values".
 *
 * Only a row that names its Branch artifact can hold values; a row without
 * `artifactId` keeps the field omitted.
 */
export async function withBranchListCustomFieldValues(
  organizationId: string,
  response: BranchListResponse
): Promise<BranchListResponse> {
  const artifactIds = [
    ...new Set(
      response.items.flatMap((row) => (row.artifactId ? [row.artifactId] : []))
    ),
  ];
  if (artifactIds.length === 0) {
    return response;
  }
  let values: CustomFieldValueDetail[];
  try {
    values = await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Branch,
      artifactIds,
      organizationId
    );
  } catch (error) {
    reportBranchListEnrichmentFailedOpen(
      BranchListEnrichmentRead.CustomFieldValues,
      error,
      { organizationId, rowCount: response.items.length }
    );
    return response;
  }
  const valuesByArtifactId = new Map<string, CustomFieldValueDetail[]>();
  for (const value of values) {
    const existing = valuesByArtifactId.get(value.entityId);
    if (existing) {
      existing.push(value);
    } else {
      valuesByArtifactId.set(value.entityId, [value]);
    }
  }
  return {
    ...response,
    items: response.items.map((row) => withRowValues(row, valuesByArtifactId)),
  };
}

function withRowValues(
  row: BranchRow,
  valuesByArtifactId: ReadonlyMap<string, CustomFieldValueDetail[]>
): BranchRow {
  if (!row.artifactId) {
    return row;
  }
  return {
    ...row,
    customFields: valuesByArtifactId.get(row.artifactId) ?? [],
  };
}
