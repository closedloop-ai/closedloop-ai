import {
  CustomFieldEntityType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { chunksOf } from "@/lib/chunks-of";

const DOCUMENT_FIELD_VALUES_READ_CHUNK_SIZE = 1000;

/** Reuse the canonical enum/people/reference projection for a document cohort. */
export async function readDocumentFieldValues(
  organizationId: string,
  artifactIds: readonly string[]
): Promise<Map<string, CustomFieldValueDetail[]> | null> {
  const ids = [...new Set(artifactIds)];
  const valuesById = new Map<string, CustomFieldValueDetail[]>();
  try {
    for (const chunk of chunksOf(ids, DOCUMENT_FIELD_VALUES_READ_CHUNK_SIZE)) {
      const values = await customFieldValuesService.getValuesForEntity(
        CustomFieldEntityType.Document,
        chunk,
        organizationId
      );
      for (const value of values) {
        const existing = valuesById.get(value.entityId);
        if (existing) {
          existing.push(value);
        } else {
          valuesById.set(value.entityId, [value]);
        }
      }
    }
    return valuesById;
  } catch (error) {
    log.warn("telemetry.enrichment_failed", {
      enrichmentKind: "document_field_values",
      organizationId,
      artifactCount: ids.length,
      error: parseError(error),
      errorClass:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}
