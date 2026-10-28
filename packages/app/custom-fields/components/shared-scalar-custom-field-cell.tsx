"use client";

import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { CUSTOM_FIELD_DATE_MAX } from "@repo/api/src/types/custom-field-date";
import { customFieldValueRejectionMessage } from "@repo/app/custom-fields/lib/value-rejection-message";
import { InlineScalarCell } from "@repo/design-system/components/ui/inline-scalar-cell";
import type { CustomFieldValueCodec } from "@repo/lib/custom-fields/custom-field-editor";
import { CustomFieldValueParseOutcome } from "@repo/lib/custom-fields/custom-field-editor";
import { dateValueAsDate } from "@repo/lib/custom-fields/date-value";
import type { CustomFieldTableValue } from "./custom-field-table-cell";

/**
 * PRD-722 (ISS-9349): the TEXT, NUMBER (and duration) and DATE custom-field
 * grid cells, rendered by the scalar champion instead of this package's own
 * hand-rolled input.
 *
 * Reached only through `CustomFieldTableCell`'s `gridview-adoption` gate, the
 * same one the CHOICE branch (`shared-enum-custom-field-cell.tsx`) sits
 * behind, which picks between this module and the legacy editor as two whole
 * shapes.
 *
 * **What this adapter owes the champion.** The codec that turns the field's
 * value into text and back (ISS-8213's duration codec included, chosen by the
 * dispatcher), the canonical refusal words for a draft the codec cannot parse
 * (ISS-9590), and a commit that can REFUSE: `onValueChange` returns the host's
 * mutation promise, so a rejected write reaches the champion's commit ledger
 * and the confirmed value goes back in the field. The hand-rolled editor
 * closed and kept the refused text in its draft.
 *
 * **What it must not lose.** An untouched cell never writes: the champion
 * commits only a draft that differs from the confirmed text, so a DURATION
 * that opens as "1h 12m" over 4,350,500 ms is never rounded on a blur. A
 * stored DATE the year gate rejected (ISS-8884) is edited as its raw text, so
 * it stays visible and can be emptied to clear it; a healthy one gets the
 * picker, bounded at the last day the field can store. A poison date with no
 * readable text is not handed here at all (see
 * {@link sharedScalarCellCanEdit}).
 */
export function SharedScalarCustomFieldCell({
  codec,
  field,
  itemLabel,
  onValueChange,
  value,
}: {
  codec: CustomFieldValueCodec;
  field: CustomFieldWithOptions;
  itemLabel: string;
  onValueChange: (value: CustomFieldTableValue) => unknown;
  value?: CustomFieldValueDetail;
}) {
  // The champion names the field "{label}" and an empty cell "Set {label}", so
  // the label carries the row too, as the CHOICE adapter's does.
  const label = `${field.name} for ${itemLabel}`;
  const draft = codec.toDraft(value);
  const onCommit = (next: string) => {
    const parsed = codec.parse(next);
    if (parsed.outcome === CustomFieldValueParseOutcome.Rejected) {
      // Unreachable through the field, which refuses this draft before it is
      // sent; a refusal here keeps an unparseable draft from ever being stored.
      return Promise.reject(new Error(parsed.reason));
    }
    // `Promise.resolve` adopts whatever the host returns, so a rejection
    // reaches the ledger. A clear writes `null`, never an empty string.
    return Promise.resolve(
      onValueChange(
        parsed.outcome === CustomFieldValueParseOutcome.Value
          ? parsed.value
          : null
      )
    );
  };

  const resting = numberRestingValue(field, value);

  if (field.fieldType === CustomFieldType.Date && !isPoisonDate(field, value)) {
    return (
      <InlineScalarCell
        label={label}
        maxDate={CUSTOM_FIELD_DATE_MAX}
        onCommit={onCommit}
        type="date"
        value={draft}
      />
    );
  }
  return (
    <InlineScalarCell
      alignEnd={field.fieldType === CustomFieldType.Number}
      draftRejection={(next) => {
        const parsed = codec.parse(next);
        return parsed.outcome === CustomFieldValueParseOutcome.Rejected
          ? customFieldValueRejectionMessage(parsed.reason, next)
          : null;
      }}
      label={label}
      onCommit={onCommit}
      restingValue={resting}
      restingValueMatches={
        resting === undefined
          ? undefined
          : (next) => {
              // "1234.50" saves 1234.5 and gets no new value back, so the
              // match is numeric, not textual.
              const parsed = codec.parse(next);
              return (
                parsed.outcome === CustomFieldValueParseOutcome.Value &&
                parsed.value === value?.numberValue
              );
            }
      }
      value={draft}
    />
  );
}

/**
 * Whether the champion can edit this value without hiding it.
 *
 * False for one case only: a stored DATE the year gate rejected whose wire
 * value carries no text (a revived Invalid Date, a numeric wire kind). Its
 * draft opens empty over a value that IS stored, and the champion reads an
 * empty draft as "no value": it would render the empty cell over the stored
 * one, and emptying the field could never clear it, because an empty draft
 * equals the empty value it opened on. The legacy editor keeps that row
 * readable and clearable (ISS-8884), so the dispatcher sends it there.
 */
export function sharedScalarCellCanEdit(
  field: CustomFieldWithOptions,
  codec: CustomFieldValueCodec,
  value?: CustomFieldValueDetail
): boolean {
  return !(isPoisonDate(field, value) && codec.toDraft(value) === "");
}

/** A stored DATE the year gate rejected (ISS-8884). */
function isPoisonDate(
  field: CustomFieldWithOptions,
  value?: CustomFieldValueDetail
): boolean {
  return (
    field.fieldType === CustomFieldType.Date &&
    value?.dateValue != null &&
    dateValueAsDate(value) === null
  );
}

/**
 * A number rests on the server's formatted displayValue ("$1,234.50", "12%",
 * "3.00 pts"), as the legacy editor did. Duration is excluded: its codec
 * already drafts from that text.
 */
function numberRestingValue(
  field: CustomFieldWithOptions,
  value?: CustomFieldValueDetail
): string | undefined {
  if (
    field.fieldType !== CustomFieldType.Number ||
    field.numberFormat === NumberFormat.Duration
  ) {
    return;
  }
  return value?.displayValue ?? undefined;
}
