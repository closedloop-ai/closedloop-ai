import { ApiError } from "../../shared/api/api-error";

/**
 * Extract a loopId from a mutation error when present. Only the
 * `loop_already_active` 409 conflict carries one (in `details.loopId` or the
 * raw `data`), so a non-null result means the user can be offered a link to
 * the existing loop. Lives in the loops slice so the shared query client
 * stays domain-free (FEA-1510).
 */
export function getLoopIdFromError(error: unknown): string | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const detailsLoopId = readString(error.details, "loopId");
  if (detailsLoopId) {
    return detailsLoopId;
  }
  const dataRecord = asRecord(error.data);
  const directLoopId = readString(dataRecord, "loopId");
  if (directLoopId) {
    return directLoopId;
  }
  return readString(asRecord(dataRecord.data), "loopId");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string
): string | null {
  const item = value?.[key];
  return typeof item === "string" && item.length > 0 ? item : null;
}
