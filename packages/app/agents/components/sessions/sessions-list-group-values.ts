import { GroupEmptyBand } from "@repo/api/src/types/custom-field-capabilities";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { sessionRowOwner } from "../../lib/session-owner";
import {
  SESSIONS_HARNESS_COLUMN_ID,
  SESSIONS_MODEL_COLUMN_ID,
  SESSIONS_OWNER_COLUMN_ID,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
} from "../../lib/sessions-table-columns";
import { UNASSIGNED_OWNER_ID } from "./sessions-list-view-state";

/**
 * What a host would WRITE to move a row into a Sessions v2 band (ISS-8296).
 *
 * A LEAF module on purpose. `sessions-list-surface-rows.tsx` derives its
 * groupable-column set from the table below and imports `ownerName`/`ownerId`
 * from here, so the dependency runs one way only. Pointing it the other way
 * makes an ESM cycle around that module-level `Set`, which reads a TDZ binding
 * and yields an EMPTY set — every column silently non-groupable, no crash.
 *
 * Distinct from `agents/lib/session-grouping.ts`, which answers a different
 * question. That module produces a band IDENTITY ("are these two rows in the
 * same band?"), and for that, falling back to a display name is a sound answer.
 * This one produces a SETTABLE VALUE, where a name is exactly the defect: it
 * would hand a host a display string dressed as an id. Neither contradicts the
 * other; they are asked different things about the same row.
 */

/**
 * How one groupable column answers both halves of the drop question.
 *
 * `canonicalValue` is `null` — not a function returning `undefined` — when the
 * field is not settable AT ALL, so "this row happens to have no value" and "no
 * row could ever have a settable value here" are different statements rather
 * than the same silence.
 */
export type SessionsGroupFieldSpec = {
  canonicalValue: ((row: SessionTableRow) => string | undefined) | null;
  emptyBand: GroupEmptyBand;
};

export function ownerName(row: SessionTableRow): string {
  return sessionRowOwner(row)?.name ?? UNASSIGNED_ASSIGNEE_LABEL;
}

/**
 * The row's owner IDENTITY, which is what the Owner facet filters and groups on.
 *
 * Not {@link ownerName}: `SessionTableRow` documents `name` as only how we spell
 * an owner, so two different people can carry the same one and a name-keyed
 * facet would return both their rows for either selection. A row with no owner —
 * or a projection carrying a name but no id — has no identity to key on and
 * falls under the shared unassigned sentinel.
 *
 * NOT the value a drop writes. See {@link ownerGroupValue}, which must tell
 * those two cases apart because it feeds a mutation rather than a filter.
 */
export function ownerId(row: SessionTableRow): string {
  return sessionRowOwner(row)?.id ?? UNASSIGNED_OWNER_ID;
}

/**
 * Which lifecycle status a drop onto this row's band would write.
 *
 * Admits POSITIVELY, on exact membership in the three-value lifecycle set, and
 * that shape is the point rather than a style choice. `SessionTableRow.status`
 * holds a DISPLAYED status, and the field is a bare `string`: a legacy desktop
 * row can still carry a stored literal `waiting` (`packages/api/AGENTS.md`), and
 * a negative check would admit that — or any other retired or version-skewed
 * spelling — as if it were a canonical lifecycle value a drop could write.
 */
function statusGroupValue(row: SessionTableRow): string | undefined {
  const lifecycle: readonly string[] = Object.values(SESSION_STATUS);
  return lifecycle.includes(row.status) ? row.status : undefined;
}

/**
 * Which owner a drop onto this row's band would write.
 *
 * Three cases, not two, because the row's Owner (`sessionRowOwner`) types `id`
 * as OPTIONAL while `name` is required. {@link ownerId} folds "no owner" and
 * "an owner we have no id for" together, which is right for a facet — both are
 * "no identity to key on" — and wrong here, because a drop WRITES: a band
 * labelled "Jane Doe" whose row carries a name but no id would hand back the
 * unassigned sentinel and UNASSIGN a session that has an owner.
 */
function ownerGroupValue(row: SessionTableRow): string | undefined {
  const owner = sessionRowOwner(row);
  if (!owner) {
    return UNASSIGNED_OWNER_ID;
  }
  return owner.id;
}

/**
 * THE table. Exhaustive over the groupable columns, so adding one is a compile
 * error here until someone decides whether its bands can be written to and what
 * its empty band means — the same reason `CUSTOM_FIELD_CAPABILITIES` next door
 * is a `Record` and not a `switch`.
 *
 * Harness and model declare `canonicalValue: null` because neither is settable:
 * both are properties of a run that already happened, and no host could honour a
 * drop onto a "Codex" or "Sonnet" band. Reading them as values was also wrong in
 * a narrower way worth recording — the harness BAND is keyed on
 * `resolveHarnessLabel`, whose lookup is case-insensitive by design because
 * producers emit both `claude` and `Claude`, so two rows rendering in one band
 * would have produced two different canonical values.
 *
 * Only `owner` declares a `Settable` empty band: "no owner" is a state a host
 * can genuinely write. A status band cannot be empty in the same sense — an
 * unreadable status is an unanswered question, not a state to move a row into.
 */
export const SESSIONS_GROUP_FIELDS = {
  [SESSIONS_STATUS_COLUMN_ID]: {
    canonicalValue: statusGroupValue,
    emptyBand: GroupEmptyBand.Undetermined,
  },
  [SESSIONS_OWNER_COLUMN_ID]: {
    canonicalValue: ownerGroupValue,
    emptyBand: GroupEmptyBand.Settable,
  },
  [SESSIONS_HARNESS_COLUMN_ID]: {
    canonicalValue: null,
    emptyBand: GroupEmptyBand.Undetermined,
  },
  [SESSIONS_MODEL_COLUMN_ID]: {
    canonicalValue: null,
    emptyBand: GroupEmptyBand.Undetermined,
  },
  // ISS-10332: groupable, and bands are NOT drop targets. A drop would be a
  // priority write, and the only writer these surfaces ship is the cell's own
  // editor (`SessionPriorityCell`) — no host wires a drop controller for it,
  // so a band that accepted the drop would move a row it could not commit.
  [SESSIONS_PRIORITY_COLUMN_ID]: {
    canonicalValue: null,
    emptyBand: GroupEmptyBand.Undetermined,
  },
} as const satisfies Record<string, SessionsGroupFieldSpec>;

export type SessionsGroupableColumnId = keyof typeof SESSIONS_GROUP_FIELDS;

/**
 * Prototype-free view of {@link SESSIONS_GROUP_FIELDS}, built once from the
 * exhaustive table so the two cannot drift.
 *
 * Null-prototype because the key is not trusted: nothing validates
 * `grouping.primary.fieldId` against the groupable set — that set only decides
 * which columns the MENU offers — so a `controlledView` host or a restored saved
 * view can name any string, and `"constructor"` off a plain object literal is a
 * truthy non-spec value.
 */
const SPEC_BY_FIELD_ID: Record<string, SessionsGroupFieldSpec> = Object.assign(
  Object.create(null),
  SESSIONS_GROUP_FIELDS
);

/**
 * The canonical value a drop onto this row's band would write, or `undefined`
 * when there is none.
 *
 * An unmapped field id degrades to "no value", which makes its bands refuse.
 * That is deliberate and matches `resolveCustomFieldCapabilities`: the field ids
 * reaching here are not validated upstream, and a lookup miss must not be the
 * one path that fails open.
 */
export function sessionsGroupCanonicalValue(
  field: string,
  row: SessionTableRow
): string | undefined {
  return SPEC_BY_FIELD_ID[field]?.canonicalValue?.(row);
}

/** What an empty band on this field means; unknown fields deny. */
export function sessionsGroupEmptyBand(field: string): GroupEmptyBand {
  return SPEC_BY_FIELD_ID[field]?.emptyBand ?? GroupEmptyBand.Undetermined;
}
