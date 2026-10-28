"use client";

import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { useUpdateCustomFieldValue } from "@repo/app/custom-fields/hooks/use-custom-fields";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { InlineEditFeedback } from "@repo/design-system/components/ui/inline-edit-feedback";
import { Input } from "@repo/design-system/components/ui/input";
import {
  CUSTOM_FIELD_DURATION_CODEC,
  CustomFieldValueParseOutcome,
  customFieldScalarCodec,
} from "@repo/lib/custom-fields/custom-field-editor";
import { useEffect, useId, useRef, useState } from "react";
import { useInlineCommit } from "../hooks/use-inline-commit";
import { customFieldValueRejectionMessage } from "../lib/value-rejection-message";
import type { BaseEditorProps } from "./custom-field-editor-props";

/**
 * The controls behind `CustomFieldEditor.Scalar` in the detail panel: one typed
 * draft each, committed on blur. `inlineCommit` adds the Details tab's save
 * behavior (ISS-12302, {@link useInlineCommit}); without it each editor
 * behaves as the Issue page's always has.
 *
 * Split out of `custom-field-value-editor.tsx` when the registry dispatch
 * landed there (ISS-9484) — the dispatcher and the choice/people pickers are a
 * separate responsibility, and the file was already near the size ceiling.
 *
 * Every one of these opens on {@link CustomFieldValueCodec.toDraft} and commits
 * through the matching `parse`, so the panel and the grid cannot disagree about
 * what a stored value looks like or what a draft means.
 */

// TextFieldEditor — blur-to-save Input

type TextFieldEditorProps = BaseEditorProps & {
  value?: CustomFieldValueDetail;
  fieldName: string;
  inlineCommit?: boolean;
};

export function TextFieldEditor({
  fieldId,
  entityType,
  entityId,
  surface,
  value,
  fieldName,
  inlineCommit = false,
}: Readonly<TextFieldEditorProps>) {
  const initialText = customFieldScalarCodec(CustomFieldType.Text).toDraft(
    value
  );
  const [text, setText] = useState(initialText);
  const focusedRef = useRef(false);
  const cancellingRef = useRef(false);
  const mutation = useUpdateCustomFieldValue(entityType, entityId, surface);
  const inline = useInlineCommit(inlineCommit, initialText, setText);

  // Sync from server when value changes, but only when not actively editing
  useEffect(() => {
    if (!focusedRef.current) {
      setText(initialText);
    }
  }, [initialText]);

  const handleBlur = () => {
    focusedRef.current = false;
    if (cancellingRef.current) {
      cancellingRef.current = false;
      return;
    }
    if (!inline.shouldWrite()) {
      return;
    }
    const value = text.trim() === "" ? null : text.trim();
    inline.commit(mutation, { fieldId, value }, value ?? "");
  };

  return (
    <Input
      aria-label={fieldName}
      onBlur={handleBlur}
      onChange={(e) => {
        setText(e.target.value);
        inline.markTouched();
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !inlineCommit) {
          event.preventDefault();
          cancellingRef.current = true;
          setText(initialText);
          event.currentTarget.blur();
          return;
        }
        inline.onKeyDown(event);
      }}
      placeholder="Enter text..."
      value={text}
    />
  );
}

// NumberFieldEditor — formatted display when unfocused, raw number when editing

type NumberFieldEditorProps = BaseEditorProps & {
  value?: CustomFieldValueDetail;
  numberFormat: string | null;
  precision: number | null;
  customLabel: string | null;
  customLabelPosition: string | null;
  fieldName: string;
  inlineCommit?: boolean;
};

function formatNumber(
  value: number,
  format: string | null,
  precision: number | null,
  label: string | null,
  labelPosition: string | null
): string {
  const decimals = precision ?? 2;
  const formatted = value.toFixed(decimals);

  if (format === NumberFormat.Currency) {
    return `$${formatted}`;
  }
  if (format === NumberFormat.Percentage) {
    return `${formatted}%`;
  }
  if (format === NumberFormat.Custom && label) {
    if (labelPosition === LabelPosition.Suffix) {
      return `${formatted} ${label}`;
    }
    return `${label} ${formatted}`;
  }
  return formatted;
}

export function NumberFieldEditor({
  fieldId,
  entityType,
  entityId,
  surface,
  value,
  numberFormat,
  precision,
  customLabel,
  customLabelPosition,
  fieldName,
  inlineCommit = false,
}: Readonly<NumberFieldEditorProps>) {
  const initialValue = value?.numberValue ?? null;
  const displayValue = value?.displayValue ?? null;
  const initialRaw = customFieldScalarCodec(CustomFieldType.Number).toDraft(
    value
  );
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState(initialRaw);
  const [error, setError] = useState<string | null>(null);
  const cancellingRef = useRef(false);
  const mutation = useUpdateCustomFieldValue(entityType, entityId, surface);
  const errorId = `${useId()}-error`;
  const inline = useInlineCommit(inlineCommit, initialRaw, (draft) => {
    setRaw(draft);
    setError(null);
  });

  // Sync from server when value changes, but only when not actively editing
  useEffect(() => {
    if (!focused) {
      setRaw(initialRaw);
      setError(null);
    }
  }, [initialRaw, focused]);

  let prefix: string | null = null;
  if (numberFormat === NumberFormat.Currency) {
    prefix = "$";
  } else if (
    numberFormat === NumberFormat.Custom &&
    customLabel &&
    customLabelPosition !== LabelPosition.Suffix
  ) {
    prefix = customLabel;
  }

  let suffix: string | null = null;
  if (numberFormat === NumberFormat.Percentage) {
    suffix = "%";
  } else if (
    numberFormat === NumberFormat.Custom &&
    customLabel &&
    customLabelPosition === LabelPosition.Suffix
  ) {
    suffix = customLabel;
  }

  let displayText = "";
  if (!focused && initialValue !== null) {
    displayText =
      displayValue ??
      formatNumber(
        initialValue,
        numberFormat,
        precision,
        customLabel,
        customLabelPosition
      );
  }

  const handleBlur = () => {
    if (cancellingRef.current) {
      cancellingRef.current = false;
      setFocused(false);
      return;
    }
    if (!inline.shouldWrite()) {
      setFocused(false);
      setError(null);
      return;
    }
    // The canonical NUMBER codec (ISS-9484), so this editor and the grid cell
    // cannot disagree about which drafts are values. `Infinity` survives
    // `isNaN` and serializes to JSON `null`, the "clear this field" payload,
    // and a partial parse like "12abc" would persist 12; the codec refuses
    // both, and a refusal keeps the typed text on screen next to the error
    // rather than writing anything.
    const parsed = customFieldScalarCodec(CustomFieldType.Number).parse(raw);
    if (parsed.outcome === CustomFieldValueParseOutcome.Rejected) {
      setError(customFieldValueRejectionMessage(parsed.reason, raw));
      return;
    }

    setFocused(false);
    setError(null);
    inline.commit(
      mutation,
      {
        fieldId,
        value:
          parsed.outcome === CustomFieldValueParseOutcome.Value
            ? parsed.value
            : null,
      },
      raw
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        {prefix && (
          <span className="shrink-0 text-muted-foreground text-sm">
            {prefix}
          </span>
        )}
        <Input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error !== null}
          aria-label={fieldName}
          onBlur={handleBlur}
          onChange={(e) => {
            setRaw(e.target.value);
            setError(null);
            inline.markTouched();
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={(event) => {
            if (!inlineCommit && event.key === "Escape") {
              event.preventDefault();
              cancellingRef.current = true;
              setRaw(initialRaw);
              setError(null);
              event.currentTarget.blur();
              return;
            }
            inline.onKeyDown(event);
          }}
          placeholder="0"
          type="text"
          value={focused ? raw : displayText}
        />
        {suffix && (
          <span className="shrink-0 text-muted-foreground text-sm">
            {suffix}
          </span>
        )}
      </div>
      {error ? <InlineEditFeedback id={errorId} message={error} /> : null}
    </div>
  );
}

// DurationFieldEditor — human span text ("1h 12m"), stored as milliseconds

type DurationFieldEditorProps = BaseEditorProps & {
  value?: CustomFieldValueDetail;
  fieldName: string;
  inlineCommit?: boolean;
};

export function DurationFieldEditor({
  fieldId,
  entityType,
  entityId,
  surface,
  value,
  fieldName,
  inlineCommit = false,
}: Readonly<DurationFieldEditorProps>) {
  const initialRaw = CUSTOM_FIELD_DURATION_CODEC.toDraft(value);
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState(initialRaw);
  const [error, setError] = useState<string | null>(null);
  const cancellingRef = useRef(false);
  const mutation = useUpdateCustomFieldValue(entityType, entityId, surface);
  const errorId = `duration-error-${fieldId}`;
  const inline = useInlineCommit(inlineCommit, initialRaw, (draft) => {
    setRaw(draft);
    setError(null);
  });

  // Sync from server when value changes, but only when not actively editing —
  // matches NumberFieldEditor's raw/focused pattern above.
  useEffect(() => {
    if (!focused) {
      setRaw(initialRaw);
      setError(null);
    }
  }, [initialRaw, focused]);

  const handleBlur = () => {
    if (cancellingRef.current) {
      cancellingRef.current = false;
      setFocused(false);
      return;
    }
    if (!inline.shouldWrite()) {
      setFocused(false);
      setError(null);
      return;
    }
    const parsed = CUSTOM_FIELD_DURATION_CODEC.parse(raw);
    if (parsed.outcome === CustomFieldValueParseOutcome.Rejected) {
      // Leave the invalid text on screen next to the error instead of
      // reverting it or silently writing garbage — the UI must not lie about
      // what is actually stored.
      setError(customFieldValueRejectionMessage(parsed.reason, raw));
      return;
    }

    setFocused(false);
    setError(null);
    inline.commit(
      mutation,
      {
        fieldId,
        value:
          parsed.outcome === CustomFieldValueParseOutcome.Value
            ? parsed.value
            : null,
      },
      raw
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error !== null}
        aria-label={fieldName}
        onBlur={handleBlur}
        onChange={(e) => {
          setRaw(e.target.value);
          setError(null);
          inline.markTouched();
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          if (!inlineCommit && event.key === "Escape") {
            event.preventDefault();
            cancellingRef.current = true;
            setRaw(initialRaw);
            setError(null);
            event.currentTarget.blur();
            return;
          }
          inline.onKeyDown(event);
        }}
        placeholder="e.g. 1h 12m"
        type="text"
        value={raw}
      />
      {error ? <InlineEditFeedback id={errorId} message={error} /> : null}
    </div>
  );
}

// DateFieldEditor — reuses DatePickerPopover

type DateFieldEditorProps = BaseEditorProps & {
  initialValue: Date | null;
  inlineCommit?: boolean;
};

export function DateFieldEditor({
  fieldId,
  entityType,
  entityId,
  surface,
  initialValue,
  inlineCommit = false,
}: Readonly<DateFieldEditorProps>) {
  const [date, setDate] = useState<Date | null>(initialValue);
  const mutation = useUpdateCustomFieldValue(entityType, entityId, surface);
  const dateKey = initialValue?.getTime() ?? null;
  const inline = useInlineCommit(
    inlineCommit,
    initialValue?.toISOString() ?? "",
    (draft) => setDate(draft === "" ? null : new Date(draft))
  );

  // Sync from server when value changes (use stable primitive dep to avoid re-firing on every render)
  useEffect(() => {
    setDate(dateKey === null ? null : new Date(dateKey));
  }, [dateKey]);

  const handleSelect = (selected: Date | null) => {
    setDate(selected);
    const value = selected ? selected.toISOString() : null;
    inline.commit(mutation, { fieldId, value }, value ?? "");
  };

  return (
    <DatePickerPopover
      className="w-full"
      onSelect={handleSelect}
      placeholder="Select date..."
      value={date}
    />
  );
}
