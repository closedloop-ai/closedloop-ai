/**
 * Defensive JSON-text parsing for sync payload fields.
 *
 * SQLite stores several session fields as free-form text that is USUALLY JSON.
 * These helpers parse such a column into the closed {@link SyncJsonValue} shape
 * the sync contract allows, degrading to the raw string (never throwing) when the
 * text is not valid JSON, and dropping values JSON cannot represent — `NaN`,
 * `Infinity`, `undefined` — rather than serializing something the server would
 * reject.
 *
 * Extracted verbatim from `agent-session-sync-service.ts` (ISS-4676).
 */
import type {
  SyncJsonObject,
  SyncJsonValue,
} from "./agent-session-sync-contract.js";

export function parseJsonValueText(value: string | null): SyncJsonValue | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  try {
    return toSyncJsonValue(JSON.parse(value));
  } catch {
    return toSyncJsonValue(value);
  }
}

export function parseJsonObjectText(
  value: string | null
): SyncJsonObject | null {
  const parsed = parseJsonValueText(value);
  return isSyncJsonObject(parsed) ? parsed : null;
}

function toSyncJsonValue(value: unknown): SyncJsonValue | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toSyncJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: SyncJsonObject = {};
    for (const [key, entry] of Object.entries(record)) {
      const parsed = toSyncJsonValue(entry);
      if (parsed !== null) {
        normalized[key] = parsed;
      }
    }
    return normalized;
  }
  return null;
}

function isSyncJsonObject(
  value: SyncJsonValue | null
): value is SyncJsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
