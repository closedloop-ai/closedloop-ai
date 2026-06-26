/**
 * Safely treats plain object values as JSON records.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Unwraps the common `{ success: true, data: {...} }` API envelope.
 */
export function unwrapApiResultData(body: unknown): Record<string, unknown> {
  const record = asRecord(body);
  if (
    record.success === true &&
    record.data &&
    typeof record.data === "object"
  ) {
    return asRecord(record.data);
  }
  return record;
}

/**
 * Extracts a redacted error message from either `error` or `error.message`.
 */
export function extractApiErrorMessage(body: unknown): string | null {
  const record = asRecord(body);
  if (typeof record.error === "string") {
    return record.error;
  }
  const errorRecord = asRecord(record.error);
  if (typeof errorRecord.message === "string") {
    return errorRecord.message;
  }
  return null;
}
