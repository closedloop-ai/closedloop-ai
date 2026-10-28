import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { isCustomFieldDateYearInRange } from "@repo/api/src/types/custom-field-date";
import {
  formatCustomFieldDurationMs,
  parseCustomFieldDurationMs,
} from "@repo/api/src/types/custom-field-duration";
import { dateValueAsDate } from "./date-value";
import { parseFiniteNumberInput } from "./finite-number-input";

/**
 * ISS-9484 — which editor a custom field's TYPE gets, and the pair that moves a
 * value between that editor's draft and storage in both directions.
 *
 * The fourth capability table beside sort, filter and group
 * (`@repo/api/src/types/custom-field-capabilities`), and it exists for the same
 * reason those do: edit dispatch was a chain of `if`s over `field.fieldType`
 * guarded by `isScalarField(fieldType: string)`, a three-member side inventory
 * widened to `string`. A ninth `CustomFieldType` compiled, matched no arm, and
 * fell through to the read-only render — the column silently lost its editor
 * with nothing failing. {@link CUSTOM_FIELD_EDITOR} is exhaustive, so that
 * member now fails `tsc` here until someone decides what edits it.
 *
 * Lives in `@repo/lib` rather than beside the capability table because the
 * NUMBER codec is {@link parseFiniteNumberInput}, this package's canonical
 * parser, which `apps/api` and both product surfaces already import. `@repo/api`
 * does not depend on `@repo/lib`, and duplicating that parser to move the table
 * up a layer would put two answers behind one question.
 *
 * Carries no copy. A refusal names a {@link CustomFieldValueRejection} and the
 * words come from the owning surface's map, so the parse rule and the sentence
 * are not maintained in the same place by the same edit.
 */

/** The control a field type is edited through. */
export const CustomFieldEditor = {
  /** A single typed draft: TEXT, NUMBER, DATE. */
  Scalar: "scalar",
  /** A bounded option list, single- or multi-pick. */
  Choice: "choice",
  People: "people",
  Reference: "reference",
  /**
   * No editor. Not "read-only by policy" — it is what a field type this build
   * has no row for resolves to, so a version-skewed peer's type degrades to an
   * inert column instead of an editor that cannot store what it collects.
   */
  None: "none",
} as const;
export type CustomFieldEditor =
  (typeof CustomFieldEditor)[keyof typeof CustomFieldEditor];

/**
 * THE editor registry. Exhaustive over `CustomFieldType` for the reason
 * `CUSTOM_FIELD_CAPABILITIES` is: a new field type is a compile error here
 * rather than a column that silently stops being editable.
 *
 * `as const satisfies` on purpose — `satisfies` keeps the keys exhaustive while
 * `as const` keeps each value a literal, which is what lets
 * {@link ScalarCustomFieldType} below be DERIVED from this table instead of
 * hand-listed beside it.
 */
export const CUSTOM_FIELD_EDITOR = {
  [CustomFieldType.Text]: CustomFieldEditor.Scalar,
  [CustomFieldType.Number]: CustomFieldEditor.Scalar,
  [CustomFieldType.Date]: CustomFieldEditor.Scalar,
  [CustomFieldType.Enum]: CustomFieldEditor.Choice,
  [CustomFieldType.MultiEnum]: CustomFieldEditor.Choice,
  [CustomFieldType.People]: CustomFieldEditor.People,
  [CustomFieldType.Reference]: CustomFieldEditor.Reference,
  [CustomFieldType.ReferenceMulti]: CustomFieldEditor.Reference,
} as const satisfies Record<CustomFieldType, CustomFieldEditor>;

/**
 * The field types {@link CUSTOM_FIELD_EDITOR} sends to the scalar editor,
 * derived from the table so the codec set below cannot drift from it. Promoting
 * a type to `Scalar` fails `tsc` until it has a codec.
 */
export type ScalarCustomFieldType = {
  [T in CustomFieldType]: (typeof CUSTOM_FIELD_EDITOR)[T] extends typeof CustomFieldEditor.Scalar
    ? T
    : never;
}[CustomFieldType];

/**
 * Why a draft cannot become a value. A code, never a sentence: the words are a
 * product decision and belong to the surface that renders them.
 */
export const CustomFieldValueRejection = {
  InvalidNumber: "invalid_number",
  InvalidDate: "invalid_date",
  /** A NUMBER field stored in milliseconds — see `custom-field-duration`. */
  InvalidDuration: "invalid_duration",
} as const;
export type CustomFieldValueRejection =
  (typeof CustomFieldValueRejection)[keyof typeof CustomFieldValueRejection];

export const CustomFieldValueParseOutcome = {
  Value: "value",
  /** The user emptied the field. A real write, not a refusal. */
  Cleared: "cleared",
  Rejected: "rejected",
} as const;
export type CustomFieldValueParseOutcome =
  (typeof CustomFieldValueParseOutcome)[keyof typeof CustomFieldValueParseOutcome];

/**
 * Three outcomes rather than `value | null`, because a caller holding a `null`
 * has to re-derive which of the two it is from the draft text — and each copy
 * of that derivation is a place a typo can be persisted as an erasure.
 *
 * Parameterised on the value so a caller that knows its field type gets that
 * type back: the detail-panel NUMBER editor sends its result to a mutation
 * typed `number | null`, and a widened `string | number` would put a cast
 * between the codec and the write.
 */
export type CustomFieldValueParse<TValue = string | number> =
  | {
      outcome: typeof CustomFieldValueParseOutcome.Value;
      value: TValue;
    }
  | { outcome: typeof CustomFieldValueParseOutcome.Cleared }
  | {
      outcome: typeof CustomFieldValueParseOutcome.Rejected;
      reason: CustomFieldValueRejection;
    };

/**
 * One field type's value codec: the pair that moves a value across the editor
 * boundary in both directions.
 *
 * Both halves live here because they are one round trip. `toDraft` used to be
 * `scalarValue`/`dateScalarDraft`, private to the grid cell, while the detail
 * panel derived its own opening text — so the two surfaces could disagree about
 * what a stored value LOOKS like even after ISS-9590 made them agree on what a
 * draft MEANS (#7902 review: tamsinb).
 *
 * `toDraft` is the string an editor's input holds, so it is defined only for
 * the types edited as text. A DATE reaches the detail panel's picker as a
 * `Date` instead; {@link dateValueAsDate} is the derivation both shapes share.
 */
export type CustomFieldValueCodec<TValue = string | number> = {
  parse: (draft: string) => CustomFieldValueParse<TValue>;
  toDraft: (value?: CustomFieldValueDetail) => string;
};

/**
 * A DATE commits only in the `YYYY-MM-DD` shape the date input emits. The year
 * gate alone cannot hold this line: a corrupt non-string wire value reaches the
 * draft as its raw text, and `new Date("0")` is a valid January 2000 the gate
 * accepts, so a no-edit blur would persist a date nobody typed (ISS-8884).
 */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CUSTOM_FIELD_SCALAR_CODEC = {
  [CustomFieldType.Text]: { parse: parseTextDraft, toDraft: textToDraft },
  [CustomFieldType.Number]: { parse: parseNumberDraft, toDraft: numberToDraft },
  [CustomFieldType.Date]: { parse: parseDateDraft, toDraft: dateToDraft },
} satisfies Record<ScalarCustomFieldType, CustomFieldValueCodec>;

/**
 * Prototype-free view for lookups keyed by request text: the field type does
 * not always arrive from inside the type boundary, and `"constructor"` off a
 * plain object literal is a truthy non-codec.
 */
const CODEC_BY_FIELD_TYPE: Record<string, CustomFieldValueCodec> =
  Object.assign(Object.create(null), CUSTOM_FIELD_SCALAR_CODEC);

const EDITOR_BY_FIELD_TYPE: Record<string, CustomFieldEditor> = Object.assign(
  Object.create(null),
  CUSTOM_FIELD_EDITOR
);

/**
 * The editor a field of this type is edited through.
 *
 * `fieldType` is widened to `string` for the reason
 * `resolveCustomFieldCapabilities` gives: a desktop or server build on the other
 * side of a rolling deploy can present a `CustomFieldType` this build has no row
 * for. Offering an editor by omission would collect a value this build cannot
 * store, so an unknown type resolves to {@link CustomFieldEditor.None}.
 */
export function resolveCustomFieldEditor(fieldType: string): CustomFieldEditor {
  return EDITOR_BY_FIELD_TYPE[fieldType] ?? CustomFieldEditor.None;
}

/**
 * This type's scalar codec, or `null` when it has none — a non-scalar type, or
 * one this build does not know. `null` rather than a permissive default: there
 * is no honest parse for a type whose storage this build cannot name, and
 * guessing one is how a typo reaches a column.
 */
export function resolveCustomFieldScalarCodec(
  fieldType: string
): CustomFieldValueCodec | null {
  return CODEC_BY_FIELD_TYPE[fieldType] ?? null;
}

/**
 * The codec for a field type the CALL SITE knows is scalar — the detail-panel
 * editors, which are built per field type rather than dispatched to.
 *
 * Total where {@link resolveCustomFieldScalarCodec} is partial, and it keeps
 * the value type: `customFieldScalarCodec(CustomFieldType.Number)` parses to a
 * `number`, not to `string | number`.
 */
export function customFieldScalarCodec<T extends ScalarCustomFieldType>(
  fieldType: T
): (typeof CUSTOM_FIELD_SCALAR_CODEC)[T] {
  return CUSTOM_FIELD_SCALAR_CODEC[fieldType];
}

/**
 * The outcome shared by every empty draft: the user cleared the field.
 *
 * Typed as the one arm rather than the whole union, so it is assignable to a
 * `CustomFieldValueParse<number>` as readily as to the widened form.
 */
export const CLEARED_CUSTOM_FIELD_VALUE: {
  outcome: typeof CustomFieldValueParseOutcome.Cleared;
} = { outcome: CustomFieldValueParseOutcome.Cleared };

/** A refusal carrying only its reason. Narrow for the reason above. */
export function rejectCustomFieldValue(reason: CustomFieldValueRejection): {
  outcome: typeof CustomFieldValueParseOutcome.Rejected;
  reason: CustomFieldValueRejection;
} {
  return { outcome: CustomFieldValueParseOutcome.Rejected, reason };
}

/**
 * "Empty means the user cleared it" is ONE rule, so it is written once and
 * every codec below only ever sees non-blank, already-trimmed text.
 */
function parseOrClear<TValue>(
  draft: string,
  parse: (trimmed: string) => CustomFieldValueParse<TValue>
): CustomFieldValueParse<TValue> {
  const trimmed = draft.trim();
  if (trimmed === "") {
    return CLEARED_CUSTOM_FIELD_VALUE;
  }
  return parse(trimmed);
}

function parseTextDraft(draft: string): CustomFieldValueParse<string> {
  return parseOrClear(draft, (trimmed) => ({
    outcome: CustomFieldValueParseOutcome.Value,
    value: trimmed,
  }));
}

function parseNumberDraft(draft: string): CustomFieldValueParse<number> {
  return parseOrClear(draft, (trimmed) => {
    const parsed = parseFiniteNumberInput(trimmed);
    if (parsed === null) {
      return rejectCustomFieldValue(CustomFieldValueRejection.InvalidNumber);
    }
    return { outcome: CustomFieldValueParseOutcome.Value, value: parsed };
  });
}

function parseDateDraft(draft: string): CustomFieldValueParse<string> {
  return parseOrClear(draft, (trimmed) => {
    if (
      !(
        CALENDAR_DATE_PATTERN.test(trimmed) &&
        isCustomFieldDateYearInRange(new Date(trimmed))
      )
    ) {
      return rejectCustomFieldValue(CustomFieldValueRejection.InvalidDate);
    }
    return { outcome: CustomFieldValueParseOutcome.Value, value: trimmed };
  });
}

/**
 * The draft-to-value half of the DURATION codec. Not a registry row — a
 * duration is a NUMBER field whose `numberFormat` says milliseconds, so
 * `fieldType` cannot select it and the flag read at each surface does (see
 * `@repo/app/custom-fields/lib/duration-field`). It lives here so the grid cell
 * and the detail-panel editor parse a span through one function rather than two.
 */
export function parseCustomFieldDurationDraft(
  draft: string
): CustomFieldValueParse<number> {
  return parseOrClear(draft, (trimmed) => {
    const milliseconds = parseCustomFieldDurationMs(trimmed);
    if (milliseconds === null) {
      return rejectCustomFieldValue(CustomFieldValueRejection.InvalidDuration);
    }
    return { outcome: CustomFieldValueParseOutcome.Value, value: milliseconds };
  });
}

/**
 * The whole DURATION codec, for a surface that has already decided this NUMBER
 * field is edited as a span. Paired so a caller selects one object rather than
 * a parser and a formatter that could come from different units.
 *
 * `toDraft` prefers the server's `displayValue` so the draft opens on the same
 * span the read path rendered. An unset value opens empty, which is distinct
 * from a stored `0` ("0s") — the storage contract in `custom-field-duration.ts`
 * turns on that distinction.
 */
export const CUSTOM_FIELD_DURATION_CODEC: CustomFieldValueCodec<number> = {
  parse: parseCustomFieldDurationDraft,
  toDraft: (value) => {
    const storedMs = value?.numberValue ?? null;
    if (storedMs === null) {
      return "";
    }
    return value?.displayValue ?? formatCustomFieldDurationMs(storedMs);
  },
};

function textToDraft(value?: CustomFieldValueDetail): string {
  return value?.textValue ?? "";
}

function numberToDraft(value?: CustomFieldValueDetail): string {
  return value?.numberValue == null ? "" : String(value.numberValue);
}

/**
 * A stored DATE the year gate rejected keeps its raw wire text in the draft, so
 * the parse arm refuses it and the value stays visible; `toISOString` runs only
 * on a value the gate accepted.
 *
 * Only a genuine unrevived STRING is real stored text. `String()` on a revived
 * Invalid Date yields the literal words "Invalid Date", and on a numeric wire
 * kind a bare "0" — artifacts of `toString`, not anything a producer sent, that
 * read in the box as if they were the stored value (marisolashgrove review). Those
 * arms open empty instead, and the caller's poison-date guard is what keeps an
 * untouched blur from reading that empty box as a clear.
 */
function dateToDraft(value?: CustomFieldValueDetail): string {
  const date = dateValueAsDate(value);
  if (date) {
    return date.toISOString().slice(0, 10);
  }
  const raw = value?.dateValue;
  return typeof raw === "string" ? raw : "";
}
