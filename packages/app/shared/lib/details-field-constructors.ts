import {
  copyValue,
  countValue,
  dateTimeValue,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-cells";
import {
  type DetailsField,
  type DetailsFieldId,
  type DetailsFieldValue,
  DetailsReadOnlyKind,
  type DetailsSelfSavingValue,
  isReadOnlyOnlyValue,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { automaticReason } from "@repo/app/shared/lib/details-lock-copy";
import type { CountNoun } from "@repo/design-system/lib/count-noun";

export type ReadOnlyDetailsEdit = {
  mode: "read-only";
  reason?:
    | { kind: typeof DetailsReadOnlyKind.NotEditable; text: string }
    | { kind: typeof DetailsReadOnlyKind.NotEditable; text?: undefined };
};

/**
 * A field production writes that the tab does not: on Session, name, status,
 * owner and project — `PATCH /agent-sessions/{id}`; priority and tags went to
 * {@link selfSavingField} with ISS-10995.
 * The default carries no reason text, because `NotEditable` would be untrue of
 * a value the user had just set (operator ruling, 2026-10-06). Unreasoned, the
 * renderer keeps the row drawn when it is empty, as ISS-12197's "has a value or
 * is editable" requires of a writable field.
 */
export function readOnlyField(
  id: DetailsFieldId,
  label: string,
  value: DetailsFieldValue,
  edit: ReadOnlyDetailsEdit = { mode: "read-only" }
): DetailsField<DetailsFieldId> {
  // Not redundant: it discriminates the value union so the read-only-only
  // kinds resolve to their own DetailsField variant.
  if (isReadOnlyOnlyValue(value)) {
    return { id, label, value, edit };
  }
  return { id, label, value, edit };
}

/**
 * A value git, the provider, the harness or the platform writes. `NotEditable`
 * with the reused lock wording, so the renderer leaves it out when empty
 * (ISS-12197's empty-row rule) and draws the hover lock (ISS-12470).
 */
export function automaticField(
  id: DetailsFieldId,
  label: string,
  value: DetailsFieldValue
): DetailsField<DetailsFieldId> {
  return readOnlyField(id, label, value, {
    mode: "read-only",
    reason: { kind: DetailsReadOnlyKind.NotEditable, text: automaticReason },
  });
}

/**
 * A user-owned artifact field the tab does not write: Owner and Due date, both
 * outside the editable set for good (operator ruling 2026-10-09). `NotEditable`
 * by kind alone, because "set automatically" would be untrue of it, so an unset
 * one is still left out.
 */
export function notYetWritableField(
  id: DetailsFieldId,
  label: string,
  value: DetailsFieldValue
): DetailsField<DetailsFieldId> {
  return readOnlyField(id, label, value, {
    mode: "read-only",
    reason: { kind: DetailsReadOnlyKind.NotEditable },
  });
}

export function copyField(
  id: DetailsFieldId,
  label: string,
  text: string | null | undefined
): DetailsField<DetailsFieldId> {
  return automaticField(id, label, copyValue(label, text));
}

export function dateTimeField(
  id: DetailsFieldId,
  label: string,
  value: Date | string | null | undefined
): DetailsField<DetailsFieldId> {
  return automaticField(id, label, dateTimeValue(value));
}

export function countField(
  id: DetailsFieldId,
  label: string,
  count: number | null | undefined,
  noun: CountNoun
): DetailsField<DetailsFieldId> {
  return automaticField(id, label, countValue(count, noun));
}

/**
 * A row whose cell owns its own write (ISS-12302's shape). Tags takes it
 * because the production tag picker resolves the org vocabulary and attaches
 * by tag id, neither of which `onSave`'s name-array can carry.
 */
export function selfSavingField(
  id: DetailsFieldId,
  label: string,
  value: DetailsSelfSavingValue
): DetailsField<DetailsFieldId> {
  return { id, label, value, edit: { mode: "self-saving" } };
}
