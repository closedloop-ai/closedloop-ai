import type { Result } from "@repo/api/src/types/result";
import {
  type ArtifactCustomFieldValueError,
  ArtifactCustomFieldValueErrorKind,
} from "./artifact-custom-field-value-contract";
import { EntityNotFoundError, FieldNotFoundError } from "./custom-field-errors";
import { InvalidReferenceTargetError } from "./reference-targets";
import { InvalidFieldValueError } from "./utils";

/** Convert expected validation refusals at the write boundary into typed data. */
export async function artifactCustomFieldValueResult<T>(
  operation: () => Promise<T>
): Promise<Result<T, ArtifactCustomFieldValueError>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof EntityNotFoundError) {
      return failure(ArtifactCustomFieldValueErrorKind.EntityNotFound, error);
    }
    if (error instanceof FieldNotFoundError) {
      return failure(ArtifactCustomFieldValueErrorKind.FieldNotFound, error);
    }
    if (
      error instanceof InvalidFieldValueError ||
      error instanceof InvalidReferenceTargetError
    ) {
      return failure(ArtifactCustomFieldValueErrorKind.InvalidValue, error);
    }
    throw error;
  }
}

function failure(
  kind: ArtifactCustomFieldValueError["kind"],
  error: Error
): Result<never, ArtifactCustomFieldValueError> {
  return { ok: false, error: { kind, message: error.message } };
}
