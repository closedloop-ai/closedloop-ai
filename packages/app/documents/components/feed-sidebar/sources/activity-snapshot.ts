import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import type { ArtifactActivityFeedItem } from "@repo/api/src/types/artifact-activity-feed";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { formatDate } from "@repo/app/shared/lib/date-utils";

/**
 * Reading the activity feed's stored snapshots (ISS-5007 rules), split out of
 * the adapter (`activity-formatting.ts`) so the wording and the parsing each
 * stay readable. Pure: no React.
 *
 * Every rule here exists because a stored value reached the feed as copy: an
 * internal serialization is never shown, ids are never shown, and every label
 * lookup is an own-property lookup.
 */

/**
 * A snapshot value as it actually reaches this module at runtime.
 *
 * The stored JSON is `JsonValue`, but the web client parses every response
 * through `reviveWithDates`, which turns an ISO-8601 string held under a
 * contract-declared `Date` key — `dueDate` and `targetDate` are both in that
 * set, and both are snapshot fields the feed renders — into a real `Date`
 * before the feed ever sees it. That is a parse boundary, so the
 * declared type does not constrain what arrives here and a revived `Date` is
 * reachable input (AGENTS.md: types stop constraining at a trust boundary).
 */
export type SnapshotScalar = JsonValue | Date | null;

/** The status receipt's provenance value for a bulk write (ISS-9436). */
const BULK_SURFACE = "bulk";

// ---------------------------------------------------------------------------
// Snapshot reading (ISS-5007 rules)
// ---------------------------------------------------------------------------

function isDateValue(raw: SnapshotScalar): raw is Date {
  return raw instanceof Date;
}

export function isJsonObject(raw: SnapshotScalar): raw is JsonObject {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    !isDateValue(raw)
  );
}

export function asJsonObject(raw: SnapshotScalar): JsonObject | null {
  return isJsonObject(raw) ? raw : null;
}

/**
 * Own-property lookup into a label map.
 *
 * Field keys and stored values are persisted data, so `__proto__`,
 * `constructor` and `toString` are all reachable keys. A bare `map[key]` walks
 * the prototype chain and hands back `Object.prototype` or a function, which
 * then reaches React as a non-element child and takes the whole feed down with
 * it. Only an own property is a real label.
 */
export function lookupOwn(
  map: Readonly<Record<string, string>>,
  key: string
): string | null {
  if (!Object.hasOwn(map, key)) {
    return null;
  }
  const label = map[key];
  return typeof label === "string" ? label : null;
}

export function readNonEmptyString(
  obj: JsonObject,
  key: string
): string | null {
  if (!Object.hasOwn(obj, key)) {
    return null;
  }
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Collapse a raw before/after snapshot into a single display string, or null
 * when there is nothing meaningful to show. Field-scoped snapshots are objects
 * — either `{ status: "TODO" }` or the `{ field, value }` envelope the write
 * path emits — and we surface the scalar value, never the wrapping key.
 *
 * An object we cannot reduce to a single scalar returns null. It used to be
 * joined into `key: value, key: value`, which is how a whole serialized
 * artifact snapshot reached the feed as visible copy (ISS-5007).
 */
export function formatSnapshotValue(raw: SnapshotScalar): string | null {
  return stringifySnapshotScalar(unwrapSnapshotScalar(raw));
}

/**
 * Peel every `{ field, value }` / single-key envelope off a snapshot and return
 * the scalar underneath, leaving anything it cannot unwrap untouched for the
 * stringifier to reject.
 */
export function unwrapSnapshotScalar(raw: SnapshotScalar): SnapshotScalar {
  const field = readFieldSnapshot(raw);
  return field === null ? raw : unwrapSnapshotScalar(field.value);
}

export function stringifySnapshotScalar(raw: SnapshotScalar): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (isDateValue(raw)) {
    return formatCalendarDate(raw);
  }
  if (typeof raw === "string") {
    // An id is not copy (ISS-5007): a value that is a uuid shows as nothing.
    return raw.length > 0 && !looksLikeId(raw) ? raw : null;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  if (Array.isArray(raw)) {
    // Only a list of plain words joins; a list holding an object or an id
    // would print "[object Object]" or a uuid, so it shows as nothing.
    const items = raw.map((item) =>
      typeof item === "string" || typeof item === "number"
        ? stringifySnapshotScalar(item)
        : null
    );
    return items.length > 0 && items.every((item) => item !== null)
      ? items.join(", ")
      : null;
  }
  return null;
}

const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored value that is an internal id (a uuid), never display copy. */
export function looksLikeId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** The unwrapped scalar as a string (a status, priority or id), else null. */
export function readScalarString(raw: SnapshotScalar): string | null {
  const scalar = unwrapSnapshotScalar(raw);
  return typeof scalar === "string" && scalar.length > 0 ? scalar : null;
}

/**
 * A field-scoped snapshot, unwrapped from either shape the write path emits:
 * the bare `{ <field>: <value> }` map and the `{ field, value }` envelope.
 *
 * No key-count bound on the envelope arm. ISS-9436's status receipt files its
 * provenance (`surface`, `result`, and a `commitGroupId` on a grouped commit)
 * as extra keys BESIDE `field`/`value`, so a receipt is a three-to-five-key
 * object that still describes exactly one field. The bare arm still needs its
 * own count, because a one-key object is only an envelope by virtue of having
 * nothing else in it.
 */
type FieldSnapshot = { field: string; value: SnapshotScalar };

function readFieldSnapshot(raw: SnapshotScalar): FieldSnapshot | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  if (Object.hasOwn(raw, "field") && Object.hasOwn(raw, "value")) {
    const field = raw.field;
    return typeof field === "string"
      ? { field, value: raw.value ?? null }
      : null;
  }
  const keys = Object.keys(raw);
  if (keys.length === 1) {
    return { field: keys[0], value: raw[keys[0]] ?? null };
  }
  return null;
}

/**
 * True when the row's receipt says it came from a bulk write: ISS-9436's
 * status provenance `surface: "bulk"`, on either side. Bulk writers that do
 * not stamp it yet (owner, priority and project batches) carry no bulk signal
 * in the feed: `transactionId` is not selected into feed items (ISS-10994).
 */
export function isBulkSurface(item: ArtifactActivityFeedItem): boolean {
  return [item.after, item.before].some((side) => {
    const obj = asJsonObject(side);
    return obj !== null && readNonEmptyString(obj, "surface") === BULK_SURFACE;
  });
}

/**
 * The field key an `assignment` event changes when the write path recorded the
 * bare id with no envelope. A legacy row like that is always an assignee.
 */
export const ASSIGNMENT_FIELD = "assignment";

/**
 * The three fields the write path records under the single `assignment`
 * action: Document assignee and approver, and a Session's owner (ISS-10994
 * C08–C11).
 */
const ASSIGNMENT_ROLE_FIELDS: ReadonlySet<string> = new Set([
  "assigneeId",
  "approverId",
  "ownerUserId",
]);

export const PROJECT_FIELD = "projectId";

/** `captureBatchTagApplied`'s field key — a tag id. */
export const TAG_FIELD = "tag";

/**
 * The raw field key this event changed, or null when the event carries no
 * field-scoped snapshot (a projection, or a `field_change` whose snapshot the
 * write path never populated).
 */
export function activityChangedFieldKey(
  item: ArtifactActivityFeedItem
): string | null {
  if (item.action === ArtifactActivityAction.StatusChange) {
    return "status";
  }
  const snapshot =
    readFieldSnapshot(item.after) ?? readFieldSnapshot(item.before);
  if (item.action === ArtifactActivityAction.Assignment) {
    const role = snapshot?.field ?? null;
    return role !== null && ASSIGNMENT_ROLE_FIELDS.has(role)
      ? role
      : ASSIGNMENT_FIELD;
  }
  return snapshot?.field ?? null;
}

/**
 * Field keys whose label is not simply the humanized key. Everything else
 * falls through to `humanizeKey`, so a field added to the write path degrades
 * to a readable phrase instead of an unmapped blank.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  [PROJECT_FIELD]: "project",
  dueDate: "due date",
  assigneeId: "assignee",
  approverId: "approver",
  ownerUserId: "owner",
};

export function fieldLabel(field: string): string {
  return lookupOwn(FIELD_LABELS, field) ?? humanizeKey(field);
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

/** "PLAN" → "Plan", "code_review" → "Code review". */
export function sentenceCase(raw: string): string {
  const words = humanizeKey(raw);
  return words.length === 0
    ? raw
    : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A due date reaches the feed as either an ISO string (the stored snapshot) or
 * a real `Date` (the same snapshot after the client's date reviver). Both
 * render through the calendar-date formatter. Anything else — an unparseable
 * string, an invalid Date, a number (an epoch is not a date a reader can
 * use), an object — is unreadable and returns null, so the row names no value
 * rather than "Invalid Date", an epoch or JSON (ISS-5007).
 */
export function formatDateValue(raw: SnapshotScalar): string | null {
  if (isDateValue(raw)) {
    return formatCalendarDate(raw);
  }
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : formatCalendarDate(parsed);
  }
  return null;
}

/**
 * Format an instant as the calendar day it denotes, read in UTC.
 *
 * A due date is a calendar date the write path stores as UTC midnight. Reading
 * it in the viewer's zone renders the previous day for everyone west of UTC,
 * so the UTC civil date is rebuilt as a local one before formatting.
 */
export function formatCalendarDate(raw: Date): string | null {
  if (Number.isNaN(raw.getTime())) {
    return null;
  }
  return formatDate(
    new Date(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate())
  );
}
