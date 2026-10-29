"use client";

import type {
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { CUSTOM_FIELD_DATE_MAX } from "@repo/api/src/types/custom-field-date";
import type { BasicUser } from "@repo/api/src/types/user";
import { isDurationFormattedField } from "@repo/app/custom-fields/lib/duration-field";
import { customFieldValueRejectionMessage } from "@repo/app/custom-fields/lib/value-rejection-message";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
  CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { toggleListValue } from "@repo/app/shared/lib/toggle-list-value";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { InlineEditFeedback } from "@repo/design-system/components/ui/inline-edit-feedback";
import { Input } from "@repo/design-system/components/ui/input";
import {
  TableChoiceListCell,
  TableReferenceListCell,
} from "@repo/design-system/components/ui/table-cell-list-primitives";
import {
  TableChoiceCell,
  TableDateCell,
  TableNumberCell,
  TablePeopleCell,
  TableTextCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import type {
  CustomFieldValueCodec,
  CustomFieldValueParse,
  CustomFieldValueRejection,
} from "@repo/lib/custom-fields/custom-field-editor";
import {
  CUSTOM_FIELD_DURATION_CODEC,
  CustomFieldEditor,
  CustomFieldValueParseOutcome,
  CustomFieldValueRejection as Rejection,
  resolveCustomFieldEditor,
  resolveCustomFieldScalarCodec,
} from "@repo/lib/custom-fields/custom-field-editor";
import { dateValueAsDate } from "@repo/lib/custom-fields/date-value";
import { useId, useState } from "react";
import { EditableReferenceCustomFieldCell } from "./custom-field-reference-table-cell";
import { SharedEnumCustomFieldCell } from "./shared-enum-custom-field-cell";
import { SharedPeopleCustomFieldCell } from "./shared-people-custom-field-cell";
import { SharedReferenceCustomFieldCell } from "./shared-reference-custom-field-cell";
import {
  SharedScalarCustomFieldCell,
  sharedScalarCellCanEdit,
} from "./shared-scalar-custom-field-cell";

export type CustomFieldTableValue = string | number | string[] | null;

export function CustomFieldTableCell({
  field,
  itemLabel,
  loadReferenceOptions,
  onValueChange,
  ownerEntityId,
  peopleOptions = [],
  referenceOptions = [],
  value,
}: {
  field: CustomFieldWithOptions;
  itemLabel: string;
  loadReferenceOptions?: (
    query: string
  ) => Promise<CustomFieldReferenceSearchResponse>;
  /**
   * ISS-9352: the return is the host's mutation promise where it has one, so a
   * REFUSED write can reach the shared cell's commit ledger and put the
   * previous option back. Typed `unknown` rather than `Promise<unknown> | void`
   * so a void-returning caller still fits without the confusing void union;
   * each editor below consumes it rather than leaking an unhandled rejection.
   */
  onValueChange?: (value: CustomFieldTableValue) => unknown;
  /**
   * The entity this cell's value belongs to. REQUIRED rather than optional
   * (ISS-8214): `resolveAndValidateReferenceTargets` rejects a target equal to
   * the owning entity, so a host that cannot name its own row would offer a
   * reference that can only ever fail to save. A missing id is a typecheck
   * error here instead of a silently unfiltered picker.
   */
  ownerEntityId: string;
  peopleOptions?: readonly BasicUser[];
  referenceOptions?: readonly CustomFieldReferenceTarget[];
  value?: CustomFieldValueDetail;
}) {
  // ISS-8213: read once, here, and let it pick between two whole editors. A
  // DURATION field is a NUMBER field, so `fieldType` alone cannot select the
  // right unit — the cell used to send `Number(draft)` for one, refusing
  // "1h 12m" and storing a bare `90` as 90 MILLISECONDS where the detail-panel
  // editor and the API both read it as 90 seconds.
  const durationFormatEnabled = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY
  );
  const sharedInlineCells = useFeatureFlagEnabledOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  if (!onValueChange) {
    return renderCustomFieldTableValue(field, value);
  }
  // ISS-9484: the field type picks its editor through the registry, not through
  // a chain of `if`s over a `string`. A field type this build has no row for —
  // a peer on the other side of a rolling deploy — resolves to `None` and
  // renders read-only rather than offering an editor that cannot store what it
  // collects.
  const editor = resolveCustomFieldEditor(field.fieldType);
  switch (editor) {
    case CustomFieldEditor.Scalar: {
      const codec = resolveScalarCellCodec(field, durationFormatEnabled);
      if (!codec) {
        return renderCustomFieldTableValue(field, value);
      }
      if (sharedInlineCells && sharedScalarCellCanEdit(field, codec, value)) {
        return (
          <SharedScalarCustomFieldCell
            codec={codec}
            field={field}
            itemLabel={itemLabel}
            onValueChange={onValueChange}
            value={value}
          />
        );
      }
      return (
        <EditableScalarCustomFieldCell
          codec={codec}
          field={field}
          itemLabel={itemLabel}
          onValueChange={onValueChange}
          value={value}
        />
      );
    }
    case CustomFieldEditor.Choice:
      // ISS-9352: one read, two whole editors per branch. The boolean never crosses into
      // either — the shared cell's own module reads the ISS-8713 clear gate it
      // needs, so neither module holds two answers to one question.
      if (sharedInlineCells) {
        return (
          <SharedEnumCustomFieldCell
            field={field}
            itemLabel={itemLabel}
            onValueChange={onValueChange}
            value={value}
          />
        );
      }
      return (
        <EditableEnumCustomFieldCell
          field={field}
          itemLabel={itemLabel}
          onValueChange={onValueChange}
          value={value}
        />
      );
    case CustomFieldEditor.People:
      if (sharedInlineCells) {
        return (
          <SharedPeopleCustomFieldCell
            field={field}
            itemLabel={itemLabel}
            onValueChange={onValueChange}
            options={peopleOptions}
            value={value}
          />
        );
      }
      return (
        <EditablePeopleCustomFieldCell
          field={field}
          itemLabel={itemLabel}
          onValueChange={onValueChange}
          options={peopleOptions}
          value={value}
        />
      );
    case CustomFieldEditor.Reference:
      if (sharedInlineCells) {
        return (
          <SharedReferenceCustomFieldCell
            field={field}
            itemLabel={itemLabel}
            loadOptions={loadReferenceOptions}
            onValueChange={onValueChange}
            options={referenceOptions}
            ownerEntityId={ownerEntityId}
            value={value}
          />
        );
      }
      return (
        <EditableReferenceCustomFieldCell
          field={field}
          itemLabel={itemLabel}
          loadOptions={loadReferenceOptions}
          onValueChange={onValueChange}
          options={referenceOptions}
          ownerEntityId={ownerEntityId}
          value={value}
        />
      );
    case CustomFieldEditor.None:
      return renderCustomFieldTableValue(field, value);
    default:
      return assertNoUnhandledEditor(editor);
  }
}

/**
 * A sixth `CustomFieldEditor` would otherwise compile and fall silently to the
 * read-only render — the same hole the registry exists to close, one level up
 * (#7901 review: bug-hunter-a and typescript-expert, independently).
 */
function assertNoUnhandledEditor(editor: never): never {
  throw new Error(`Unhandled custom-field editor: ${String(editor)}`);
}

function EditableScalarCustomFieldCell({
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
  const initialValue = codec.toDraft(value);
  // A stored DATE the year gate rejected is edited as plain text: a native date
  // input sanitizes the raw value to an empty box and fires no change event on
  // Backspace, so the row could never be cleared (ISS-8884).
  const isPoisonDate =
    field.fieldType === CustomFieldType.Date &&
    value?.dateValue != null &&
    dateValueAsDate(value) === null;
  const dateInput = field.fieldType === CustomFieldType.Date && !isPoisonDate;
  const [draft, setDraft] = useState(initialValue);
  const [editing, setEditing] = useState(false);
  const [touched, setTouched] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const validationErrorId = useId();
  // A new stored value replaces the draft unless the user, still in the cell,
  // has typed a change a commit would send (ISS-9589): replacing it mid-edit
  // threw that typing away. Held, it is what Escape restores, and a commit
  // sends the typing over it. Typing that ended where it began is no change,
  // so it is replaced, or the blur would write the old value back. A refusal
  // on blur leaves its typing in a cell nobody is editing, so an unfocused
  // cell is replaced too, or it would pin against every later update; a
  // refusal on Enter keeps focus, and the user is still typing next to the
  // error (marisolashgrove review, PR #7836). Adjusted during render rather than
  // in an effect so reading `touched` here does not re-seed on every edit end.
  const [seededFrom, setSeededFrom] = useState(initialValue);
  if (seededFrom !== initialValue) {
    setSeededFrom(initialValue);
    if (!(touched && focused) || draft === seededFrom) {
      setDraft(initialValue);
      setTouched(false);
      setValidationError(null);
    }
  }

  const finish = (commit: boolean) => {
    if (commit) {
      const parsed = codec.parse(draft);
      const rejection = scalarRejection(parsed, isPoisonDate, touched);
      if (rejection) {
        setValidationError(customFieldValueRejectionMessage(rejection, draft));
        return;
      }
      // ISS-8213 (codex P1, PR #7220): an UNTOUCHED cell never writes. The draft
      // is a RENDERING of the stored value, not the value — a DURATION caps at
      // two units, so 4,350,500 ms opens as "1h 12m" and re-parses to 4,320,000.
      // Committing on a blur the user never typed into therefore silently
      // rewrote the row to a rounded number that still reads as a real
      // measurement. Merely opening a cell and tabbing away is not an edit.
      if (touched) {
        consumeWrite(
          onValueChange(
            parsed.outcome === CustomFieldValueParseOutcome.Value
              ? parsed.value
              : null
          )
        );
      }
    } else {
      setDraft(initialValue);
    }
    setValidationError(null);
    setTouched(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <Input
          aria-describedby={validationError ? validationErrorId : undefined}
          aria-invalid={validationError !== null}
          aria-label={`Edit ${field.name} for ${itemLabel}`}
          autoFocus
          className="h-8"
          max={dateInput ? CUSTOM_FIELD_DATE_MAX : undefined}
          onBlur={() => {
            setFocused(false);
            finish(true);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            setTouched(true);
            setValidationError(null);
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              finish(false);
            }
          }}
          type={dateInput ? "date" : "text"}
          value={draft}
        />
        {validationError ? (
          <InlineEditFeedback
            id={validationErrorId}
            message={validationError}
            truncate
          />
        ) : null}
      </div>
    );
  }

  return (
    <button
      aria-label={`Edit ${field.name} for ${itemLabel}`}
      className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-muted"
      data-grid-primary-editor=""
      onClick={() => setEditing(true)}
      type="button"
    >
      {renderCustomFieldTableValue(field, value)}
    </button>
  );
}

function EditableEnumCustomFieldCell({
  field,
  itemLabel,
  onValueChange,
  value,
}: {
  field: CustomFieldWithOptions;
  itemLabel: string;
  onValueChange: (value: CustomFieldTableValue) => unknown;
  value?: CustomFieldValueDetail;
}) {
  const clearEnabled = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY
  );
  let selectedIds = value?.multiEnumValues.map((option) => option.id) ?? [];
  if (field.fieldType === CustomFieldType.Enum) {
    selectedIds = value?.enumValue ? [value.enumValue.id] : [];
  }
  const multiple = field.fieldType === CustomFieldType.MultiEnum;
  // Single-select only: a radio group cannot be un-picked by re-picking it, so
  // without this the first choice is permanent. MULTI_ENUM needs no equivalent
  // — every entry already toggles off through its own checkbox.
  const canClear =
    clearEnabled && !multiple && selectedIds.length > 0 && Boolean(value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit ${field.name} for ${itemLabel}`}
          className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-muted"
          data-grid-primary-editor=""
          type="button"
        >
          {renderCustomFieldTableValue(field, value)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {multiple ? (
          field.enumOptions.map((option) => (
            <DropdownMenuCheckboxItem
              checked={selectedIds.includes(option.id)}
              key={option.id}
              onCheckedChange={() =>
                consumeWrite(
                  onValueChange(toggleListValue(selectedIds, option.id))
                )
              }
              onSelect={(event) => event.preventDefault()}
            >
              {option.name}
            </DropdownMenuCheckboxItem>
          ))
        ) : (
          <DropdownMenuRadioGroup
            onValueChange={(optionId) => consumeWrite(onValueChange(optionId))}
            value={selectedIds[0] ?? ""}
          >
            {field.enumOptions.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.id}>
                {option.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        {canClear ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => consumeWrite(onValueChange(null))}
            >
              Clear {field.name}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditablePeopleCustomFieldCell({
  field,
  itemLabel,
  onValueChange,
  options,
  value,
}: {
  field: CustomFieldWithOptions;
  itemLabel: string;
  onValueChange: (value: CustomFieldTableValue) => unknown;
  options: readonly BasicUser[];
  value?: CustomFieldValueDetail;
}) {
  const selectedIds = value?.peopleValues.map((person) => person.id) ?? [];
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOptions = options.filter((person) =>
    getUserDisplayName(person).toLowerCase().includes(normalizedQuery)
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit ${field.name} for ${itemLabel}`}
          className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-muted"
          data-grid-primary-editor=""
          type="button"
        >
          <TablePeopleCell
            people={(value?.peopleValues ?? []).map((person) => ({
              avatarUrl: person.avatarUrl ?? undefined,
              name: getUserDisplayName(person),
            }))}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{field.name}</DropdownMenuLabel>
        <div className="px-2 pb-1">
          <Input
            aria-label={`Search ${field.name} people`}
            className="h-8"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Search people…"
            value={query}
          />
        </div>
        {matchingOptions.map((person) => (
          <DropdownMenuCheckboxItem
            checked={selectedIds.includes(person.id)}
            key={person.id}
            onCheckedChange={() =>
              consumeWrite(
                onValueChange(toggleListValue(selectedIds, person.id))
              )
            }
            onSelect={(event) => event.preventDefault()}
          >
            {getUserDisplayName(person)}
          </DropdownMenuCheckboxItem>
        ))}
        {matchingOptions.length === 0 ? (
          <p className="px-2 py-3 text-muted-foreground text-sm">
            No matching people
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function renderCustomFieldTableValue(
  field: CustomFieldWithOptions,
  value?: CustomFieldValueDetail
) {
  switch (field.fieldType) {
    case CustomFieldType.Text:
      return <TableTextCell value={value?.textValue} />;
    case CustomFieldType.Number:
      return <TableNumberCell value={value?.displayValue} />;
    case CustomFieldType.Enum:
      return <TableChoiceCell label={value?.enumValue?.name} />;
    case CustomFieldType.MultiEnum:
      return (
        <TableChoiceListCell
          choices={(value?.multiEnumValues ?? []).map((option) => ({
            id: option.id,
            label: option.name,
          }))}
        />
      );
    case CustomFieldType.Date:
      return (
        <TableDateCell
          fullValue={dateValueAsDate(value)?.toISOString()}
          value={value?.displayValue}
        />
      );
    case CustomFieldType.People:
      return (
        <TablePeopleCell
          people={(value?.peopleValues ?? []).map((person) => ({
            avatarUrl: person.avatarUrl ?? undefined,
            name: getUserDisplayName(person),
          }))}
        />
      );
    case CustomFieldType.Reference:
    case CustomFieldType.ReferenceMulti:
      return (
        <TableReferenceListCell
          references={(value?.referenceValues ?? []).map((reference) => ({
            id: reference.id,
            label: reference.slug ?? reference.name,
            tooltip: reference.name,
          }))}
        />
      );
    default:
      return <GridEmptyValue />;
  }
}

/**
 * Why this commit is refused, or `null` to let it through.
 *
 * An empty draft is a real clear only when the user emptied it. A poison row
 * whose stored value has no editable text opens empty, so without the `touched`
 * arm a plain click-then-blur would delete it (marisolashgrove review). NUMBER and
 * a healthy DATE never take that arm — `isPoisonDate` is DATE-only, which is
 * why the reason it names is the date one.
 */
function scalarRejection(
  parsed: CustomFieldValueParse,
  isPoisonDate: boolean,
  touched: boolean
): CustomFieldValueRejection | null {
  if (parsed.outcome === CustomFieldValueParseOutcome.Rejected) {
    return parsed.reason;
  }
  if (
    parsed.outcome === CustomFieldValueParseOutcome.Cleared &&
    isPoisonDate &&
    !touched
  ) {
    return Rejection.InvalidDate;
  }
  return null;
}

/**
 * The codec this scalar cell edits through, or `null` when the registry has no
 * codec for the field's type.
 *
 * ISS-8213: the duration flag is read once at the dispatcher and picks a whole
 * codec here, so no inner helper has to re-derive "is this a duration?" and
 * reach a different answer. `CUSTOM_FIELD_DURATION_CODEC` is the same pair the
 * detail-panel `DurationFieldEditor` uses, which is what makes the two surfaces
 * agree on the unit by construction instead of by convention.
 *
 * `null` is unreachable within one build — `ScalarCustomFieldType` derives the
 * codec table's keys from the registry's `Scalar` rows, so a type that resolves
 * to `Scalar` provably has a codec. It is the shape the partial lookup owes its
 * `string` argument, not a case a test can reach (#7901 review: test-strategist).
 */
function resolveScalarCellCodec(
  field: CustomFieldWithOptions,
  durationFormatEnabled: boolean | undefined
): CustomFieldValueCodec | null {
  if (durationFormatEnabled && isDurationFormattedField(field)) {
    return CUSTOM_FIELD_DURATION_CODEC;
  }
  return resolveCustomFieldScalarCodec(field.fieldType);
}

/**
 * Consumes a write the legacy editors do not await. They have no rollback, so
 * a rejection has nothing to tell them — but an unconsumed one surfaces as an
 * unhandled rejection now that `onValueChange` may return a promise. The shared
 * QueryClient already owns the user-facing error, so this adds no second toast.
 */
function consumeWrite(result: unknown): void {
  Promise.resolve(result).catch(() => undefined);
}
