"use client";

import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import { InlineScalarCell } from "@repo/design-system/components/ui/inline-scalar-cell";
import { Input } from "@repo/design-system/components/ui/input";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { useEffect, useRef, useState } from "react";
import type { GenericArtifact } from "../fixtures";
import {
  EditableMultiSelectCell,
  EditableOwnerCell,
  EditableReferenceCell,
  EditableSingleSelectCell,
  EmptyCustomValue,
  showSavedToast,
} from "./artifact-list-custom-cells";
import { customFieldReferenceValues } from "./artifact-list-custom-field-model";
import { kindIcon } from "./artifact-list-model";

export function InlineCustomFieldCell({
  ariaLabel,
  initialValue,
  type,
}: {
  ariaLabel: string;
  initialValue: string;
  type: "date" | "number" | "text";
}) {
  const [value, setValue] = useState(initialValue);
  const onCommit = (next: string) => {
    const previous = value;
    showSavedToast("Field updated", () => setValue(previous));
    setValue(next);
  };
  // ISS-9590: the number branch is dispatched to rather than passed `type`,
  // because only it can refuse a draft and only it carries the words for that
  // refusal — the same ones `custom-field-table-cell.tsx` shows.
  if (type === "number") {
    return (
      <InlineScalarCell
        invalidMessage={INLINE_SCALAR_NUMBER_INVALID_MESSAGE}
        label={ariaLabel}
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage={INLINE_EDIT_SAVE_ERROR_MESSAGE}
        type="number"
        value={value}
      />
    );
  }
  return (
    <InlineScalarCell
      label={ariaLabel}
      onCommit={onCommit}
      retainRejectedDraft
      saveErrorMessage={INLINE_EDIT_SAVE_ERROR_MESSAGE}
      type={type}
      value={value}
    />
  );
}

function InlineTimeCell({
  ariaLabel,
  initialValue,
}: {
  ariaLabel: string;
  initialValue: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [draft, setDraft] = useState(initialValue);
  const [editing, setEditing] = useState(Boolean(initialValue));
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelingRef = useRef(false);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);
  const commit = () => {
    if (draft === value) {
      return;
    }
    const previous = value;
    setValue(draft);
    setEditing(Boolean(draft));
    showSavedToast("Field updated", () => {
      setValue(previous);
      setDraft(previous);
      setEditing(Boolean(previous));
    });
  };
  if (!(editing || value)) {
    return (
      <button
        aria-label={ariaLabel}
        className="group w-full text-left"
        onClick={() => setEditing(true)}
        type="button"
      >
        <EmptyCustomValue />
      </button>
    );
  }
  return (
    <Input
      aria-label={ariaLabel}
      className="h-7 min-w-0 border-transparent bg-transparent px-1.5 font-mono text-sm shadow-none hover:bg-muted focus-visible:bg-background"
      onBlur={() => {
        if (cancelingRef.current) {
          cancelingRef.current = false;
          return;
        }
        commit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancelingRef.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      ref={inputRef}
      type="time"
      value={draft}
    />
  );
}

export function CustomFieldCell({
  artifact,
  field,
  referenceArtifacts,
}: {
  artifact: GenericArtifact;
  field: CustomFieldDefinition;
  referenceArtifacts: readonly GenericArtifact[];
}) {
  const createdValue = artifact.creationValues?.[field.id];
  const optionIndex = artifact.title.length % (field.options?.length || 1);
  const option = field.options?.[optionIndex];
  const showEmptyState = Number(artifact.id.split("-").at(-1)) % 3 === 0;
  const initial = <Value,>(value: Value, emptyValue: Value): Value =>
    createdValue === undefined && showEmptyState ? emptyValue : value;
  const referenceValues = customFieldReferenceValues(
    field,
    referenceArtifacts,
    artifact
  );
  const referenceOptions = referenceValues.flatMap((slug) => {
    const candidate = referenceArtifacts.find((item) => item.slug === slug);
    return candidate
      ? [
          {
            icon: kindIcon[candidate.kind],
            id: candidate.slug,
            slug: candidate.slug,
            title: candidate.title,
          },
        ]
      : [];
  });
  switch (field.type) {
    case "Single-select":
      return (
        <EditableSingleSelectCell
          initialValue={initial(
            typeof createdValue === "string" ? createdValue : option,
            undefined
          )}
          label={field.label}
          optionColors={field.optionColors ?? []}
          options={field.options ?? []}
        />
      );
    case "Multi-select":
      return (
        <EditableMultiSelectCell
          initialValues={initial(
            Array.isArray(createdValue)
              ? [...createdValue]
              : (field.options ?? []).slice(0, 2),
            []
          )}
          label={field.label}
          optionColors={field.optionColors ?? []}
          options={field.options ?? []}
        />
      );
    case "Date":
      return (
        <InlineCustomFieldCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(
            dateValue(createdValue, artifact.title.length),
            ""
          )}
          type="date"
        />
      );
    case "People":
      return (
        <EditableOwnerCell
          initialInitials={artifact.ownerInitials}
          initialOwner={artifact.owner}
        />
      );
    case "Reference":
      return (
        <EditableReferenceCell
          initialValues={initial(referenceValues.slice(0, 1), [])}
          multiple={false}
          options={referenceOptions}
          source={field.sources?.[0]}
        />
      );
    case "Reference (multi)":
      return (
        <EditableReferenceCell
          initialValues={initial(referenceValues.slice(0, 3), [])}
          multiple
          options={referenceOptions}
          source={field.sources?.[0]}
        />
      );
    case "Time":
      return (
        <InlineTimeCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(
            timeValue(createdValue, artifact.title.length),
            ""
          )}
        />
      );
    case "Number":
      return (
        <InlineCustomFieldCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(
            numberValue(createdValue, artifact.title.length),
            ""
          )}
          type="number"
        />
      );
    case "Text":
      return (
        <InlineCustomFieldCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(textValue(createdValue), "")}
          type="text"
        />
      );
    default:
      return null;
  }
}

function dateValue(value: unknown, titleLength: number): string {
  return typeof value === "string"
    ? value
    : `2026-07-${20 + (titleLength % 9)}`;
}

function timeValue(value: unknown, titleLength: number): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : `02:${String((12 + titleLength) % 60).padStart(2, "0")}`;
}

function numberValue(value: unknown, titleLength: number): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : String(100 + titleLength * 7);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "Custom text value";
}
