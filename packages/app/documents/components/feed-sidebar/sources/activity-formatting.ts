import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { formatDate } from "@repo/app/shared/lib/date-utils";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";

/**
 * Pure, surface-agnostic formatting for one activity-timeline row (FEA-3875).
 * Turns the normalized `ArtifactActivityFeedItem` (store event OR on-read
 * projection) into the plain-language pieces the Asana-style card renders:
 * a headline verb phrase and an optional before→after pair. Kept free of React
 * so it is trivially unit-tested and reused by both the web and desktop cards.
 *
 * ISS-5007: this module is the audit trail's whole vocabulary, so it never
 * emits an internal serialization. A snapshot it cannot resolve to a
 * human-readable value yields `null` (the row renders its headline and no
 * value chip) rather than a `key: value, key: value` dump of the stored JSON.
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
 * Treating one as a plain object is what made a live due-date change render no
 * chip at all.
 */
export type SnapshotScalar = JsonValue | Date | null;

function isDateValue(value: SnapshotScalar): value is Date {
  return value instanceof Date;
}

function isJsonObject(value: SnapshotScalar): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isDateValue(value)
  );
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
function lookupOwn(
  map: Readonly<Record<string, string>>,
  key: string
): string | null {
  if (!Object.hasOwn(map, key)) {
    return null;
  }
  const label = map[key];
  return typeof label === "string" ? label : null;
}

function readString(obj: JsonObject | null, key: string): string | null {
  if (obj === null) {
    return null;
  }
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/**
 * Collapse a raw before/after snapshot into a single display string, or null
 * when there is nothing meaningful to show. Field-scoped snapshots are objects
 * — either `{ status: "TODO" }` or the `{ field, value }` envelope the write
 * path emits — and we surface the scalar value, never the wrapping key, which
 * the headline already names.
 *
 * An object we cannot reduce to a single scalar returns null. It used to be
 * joined into `key: value, key: value`, which is how a whole serialized
 * artifact snapshot reached the feed as visible copy (ISS-5007).
 */
export function formatSnapshotValue(value: SnapshotScalar): string | null {
  return stringifySnapshotScalar(unwrapSnapshotScalar(value));
}

/**
 * Peel every `{ field, value }` / single-key envelope off a snapshot and return
 * the scalar underneath, leaving anything it cannot unwrap untouched for the
 * stringifier to reject.
 */
function unwrapSnapshotScalar(value: SnapshotScalar): SnapshotScalar {
  const field = readFieldSnapshot(value);
  return field === null ? value : unwrapSnapshotScalar(field.value);
}

/**
 * Render an already-unwrapped scalar as display copy, or null when there is
 * nothing showable. An object that survived unwrapping yields null — it used to
 * be joined into `key: value, key: value`, which is how a whole serialized
 * artifact snapshot reached the feed as visible copy (ISS-5007).
 */
function stringifySnapshotScalar(value: SnapshotScalar): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (isDateValue(value)) {
    return formatCalendarDate(value);
  }
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(String).join(", ") : null;
  }
  return null;
}

/** The before→after pair for a row, each already collapsed to a display string. */
export type ActivityChange = {
  before: string | null;
  after: string | null;
};

/**
 * The before→after value pair for a row, already collapsed and labelled.
 *
 * Three rules keep an internal serialization out of the audit trail
 * (ISS-5007):
 * - A `creation` event's `after` is a summary of the artifact as it was created
 *   (`{ status, title }`), not a change. It has no before→after pair to show,
 *   and rendering it as one is what put a serialized snapshot on screen.
 * - A field whose values are opaque internal ids (project, assignee) shows no
 *   value chips; a uuid tells a reader nothing the headline has not said.
 * - Everything else is resolved through the canonical label maps, so the feed
 *   says "Medium", not "MEDIUM", and "In Review", not "IN_REVIEW".
 */
export function deriveActivityChange(
  item: ArtifactActivityFeedItem
): ActivityChange {
  if (item.action === ArtifactActivityAction.Creation) {
    return { before: null, after: null };
  }
  const field = changedFieldKey(item);
  if (field !== null && OPAQUE_ID_FIELDS.has(field)) {
    return { before: null, after: null };
  }
  return {
    before: formatFieldValue(item.before, field),
    after: formatFieldValue(item.after, field),
  };
}

/**
 * The plain-language headline for a row. Store `event` items use their action
 * vocabulary (status/field/assignment/creation); every projection derives its
 * headline from `source` + `payload` instead (its `action` is null).
 */
export function describeActivity(item: ArtifactActivityFeedItem): string {
  if (item.source === ActivityFeedItemSource.Event) {
    return describeEvent(item);
  }
  return describeProjection(item);
}

function describeEvent(item: ArtifactActivityFeedItem): string {
  switch (item.action) {
    case ArtifactActivityAction.StatusChange:
      return "changed the status";
    case ArtifactActivityAction.Assignment: {
      // A legacy row (bare id, no envelope) cannot say which role moved, so it
      // keeps the old generic headline; a row carrying the envelope names it.
      const role = changedFieldKey(item);
      return role === null || role === ASSIGNMENT_FIELD
        ? "updated the assignment"
        : `updated the ${fieldLabel(role)}`;
    }
    case ArtifactActivityAction.Creation:
      return "created this artifact";
    case ArtifactActivityAction.FieldChange: {
      const field = changedFieldKey(item);
      return field ? `updated the ${fieldLabel(field)}` : "updated a field";
    }
    default:
      return "made a change";
  }
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function describeProjection(item: ArtifactActivityFeedItem): string {
  const payload = isJsonObject(item.payload) ? item.payload : null;
  switch (item.source) {
    case ActivityFeedItemSource.VersionCreated: {
      const version = payload?.version;
      return typeof version === "number"
        ? `saved version ${version}`
        : "saved a new version";
    }
    case ActivityFeedItemSource.Derivation: {
      const direction = readString(payload, "direction");
      return direction === "produced_from"
        ? "was derived from another artifact"
        : "produced a related artifact";
    }
    case ActivityFeedItemSource.Loop: {
      // ISS-5474: the product has no user-facing Loops concept, so this feed
      // entry names the ACTION the user took, not the run object or its state.
      // The enum member keeps its internal name; only the copy changed.
      return "started an agent run on this artifact";
    }
    case ActivityFeedItemSource.Evaluation: {
      const reportType = readString(payload, "reportType");
      return reportType
        ? `evaluated (${humanizeKey(reportType)})`
        : "ran an evaluation";
    }
    default:
      return "updated this artifact";
  }
}

/**
 * The field key an `assignment` event changes. The write path records the
 * assignee/approver id as a bare string with no envelope, so there is no key to
 * read off the snapshot — this is the stable name the rest of the module uses
 * for that pair.
 */
const ASSIGNMENT_FIELD = "assignment";

/**
 * The two artifact fields the write path records under the single `assignment`
 * action. It emits one event per field, so without the `{ field, value }`
 * envelope an assignee swap and an approver swap are indistinguishable — two
 * rows from one save read as the same field changing twice. New rows carry the
 * envelope; rows written before it fall back to `ASSIGNMENT_FIELD`.
 */
const ASSIGNMENT_ROLE_FIELDS: ReadonlySet<string> = new Set([
  "assigneeId",
  "approverId",
]);

/**
 * Fields whose stored values are opaque internal ids. A uuid in the audit trail
 * is the same defect as a serialized blob — it tells a reader nothing — so
 * these render their headline and no value chip. Assignment ids are the one
 * exception the card resolves to a real person (see `readAssignmentIds`).
 */
const PROJECT_FIELD = "projectId";

const OPAQUE_ID_FIELDS: ReadonlySet<string> = new Set([
  PROJECT_FIELD,
  ASSIGNMENT_FIELD,
  ...ASSIGNMENT_ROLE_FIELDS,
]);

/**
 * Field keys whose label is not simply the humanized key. `projectId` would
 * read "project id" and `dueDate` is only correct by accident; everything else
 * falls through to `humanizeKey`, so a field added to the write path degrades
 * to a readable phrase instead of an unmapped blank.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  [PROJECT_FIELD]: "project",
  dueDate: "due date",
  assigneeId: "assignee",
  approverId: "approver",
};

/**
 * Per-field value vocabularies, spread from the canonical label maps so the
 * feed cannot drift from the badge, the picker, or the table (AGENTS.md: a
 * canonical label map is the single source for user-facing labels).
 */
const FIELD_VALUE_LABELS: Readonly<Record<string, Record<string, string>>> = {
  status: { ...ARTIFACT_STATUS_LABELS },
  priority: { ...PRIORITY_LABELS },
};

/** Field keys whose value is an ISO date string rather than a display string. */
const DATE_FIELDS: ReadonlySet<string> = new Set(["dueDate"]);

/**
 * A field-scoped snapshot, unwrapped from either shape the write path emits:
 * the bare `{ <field>: <value> }` map and the `{ field, value }` envelope
 * `diffArtifactFields` records for priority / title / dueDate / projectId.
 * The envelope is what leaked "field: priority, value: MEDIUM" into the feed
 * (ISS-5007) — it was read as a two-key object and joined verbatim.
 */
type FieldSnapshot = { field: string; value: SnapshotScalar };

function readFieldSnapshot(value: SnapshotScalar): FieldSnapshot | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length === 2 && "field" in value && "value" in value) {
    const field = value.field;
    return typeof field === "string"
      ? { field, value: value.value ?? null }
      : null;
  }
  if (keys.length === 1) {
    return { field: keys[0], value: value[keys[0]] ?? null };
  }
  return null;
}

/**
 * The raw field key this event changed, or null when the event carries no
 * field-scoped snapshot (a projection, or a `field_change` whose snapshot the
 * write path never populated).
 */
function changedFieldKey(item: ArtifactActivityFeedItem): string | null {
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

function fieldLabel(field: string): string {
  return lookupOwn(FIELD_LABELS, field) ?? humanizeKey(field);
}

/**
 * Collapse one side of a change to the string the chip shows: the scalar behind
 * whatever snapshot shape it arrived in, then the canonical display label for
 * that field's vocabulary. Returns null when there is nothing to show, which
 * the card renders as an absent chip rather than an empty one.
 */
function formatFieldValue(
  raw: SnapshotScalar,
  field: string | null
): string | null {
  const scalar = unwrapSnapshotScalar(raw);
  if (field !== null && DATE_FIELDS.has(field)) {
    return formatDateValue(scalar);
  }
  const value = stringifySnapshotScalar(scalar);
  if (value === null || field === null) {
    return value;
  }
  return lookupValueLabel(field, value) ?? value;
}

/**
 * The display label for one value of a field with its own vocabulary, or null
 * when that field has no vocabulary or the value is not in it. Both hops are
 * own-property lookups: `field` and `value` are both persisted data.
 */
function lookupValueLabel(field: string, value: string): string | null {
  if (!Object.hasOwn(FIELD_VALUE_LABELS, field)) {
    return null;
  }
  return lookupOwn(FIELD_VALUE_LABELS[field], value);
}

/**
 * A due date reaches the feed as either an ISO string (the stored snapshot) or
 * a real `Date` (the same snapshot after the client's date reviver). Both
 * render through the calendar-date formatter; an unparseable value falls back
 * to the raw string rather than to "Invalid Date".
 */
function formatDateValue(value: SnapshotScalar): string | null {
  if (isDateValue(value)) {
    return formatCalendarDate(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : formatCalendarDate(parsed);
  }
  return stringifySnapshotScalar(value);
}

/**
 * Format an instant as the calendar day it denotes, read in UTC.
 *
 * A due date is a calendar date the write path stores as UTC midnight. Reading
 * it in the viewer's zone renders the previous day for everyone west of UTC —
 * a date that is simply wrong, not merely differently formatted — so the UTC
 * civil date is rebuilt as a local one before formatting. Same intent as
 * `parseDateLocal` for date-only strings.
 */
function formatCalendarDate(value: Date): string | null {
  if (Number.isNaN(value.getTime())) {
    return null;
  }
  return formatDate(
    new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
}

/**
 * The raw actor ids on an `assignment` event, or null for every other row.
 *
 * Kept separate from `deriveActivityChange` (which suppresses them) because
 * only the card can turn an id into a person — it has the org-user map that
 * `ActivityActor` already loads. A pure formatter has no way to, and rendering
 * the id itself is the ISS-5007 defect.
 */
export function readAssignmentIds(
  item: ArtifactActivityFeedItem
): ActivityChange | null {
  if (item.action !== ArtifactActivityAction.Assignment) {
    return null;
  }
  // Either shape the write path has emitted: the bare id string (rows written
  // before the role envelope) or the `{ field, value }` envelope naming the role.
  return {
    before: readIdValue(item.before),
    after: readIdValue(item.after),
  };
}

/**
 * The raw project ids on a `projectId` field change, or null for every other
 * row.
 *
 * Same seam as `readAssignmentIds`: `deriveActivityChange` suppresses the ids
 * because a uuid is not copy, but "updated the project" with nothing else on
 * the row is a dead audit entry — the reader cannot tell what moved where. Only
 * the card can name a project, so the ids come out here and the card resolves
 * them against the org-project directory.
 */
export function readProjectIds(
  item: ArtifactActivityFeedItem
): ActivityChange | null {
  if (item.action !== ArtifactActivityAction.FieldChange) {
    return null;
  }
  if (changedFieldKey(item) !== PROJECT_FIELD) {
    return null;
  }
  return {
    before: readIdValue(item.before),
    after: readIdValue(item.after),
  };
}

function readIdValue(raw: SnapshotScalar): string | null {
  const value = unwrapSnapshotScalar(raw);
  return typeof value === "string" && value.length > 0 ? value : null;
}
