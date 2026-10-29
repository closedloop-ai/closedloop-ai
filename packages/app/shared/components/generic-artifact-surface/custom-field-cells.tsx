"use client";

import { formatDate } from "@repo/app/shared/lib/date-utils";
import { toggleListValue } from "@repo/app/shared/lib/toggle-list-value";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { TableChoiceListCell } from "@repo/design-system/components/ui/table-cell-list-primitives";
import {
  TableChoiceCell,
  TableDateCell,
  TableNumberCell,
  TableTextCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import { useEffect, useState } from "react";
import { EditableOwnerTableCell } from "./editable-cells";
import { type ArtifactRow, artifactPeople } from "./fixtures";
import { EditableReferenceFieldCell } from "./reference-field-cell";

export function CustomFieldCell({
  artifact,
  field,
  onArtifactChange,
}: {
  artifact: ArtifactRow;
  field: CustomFieldDefinition;
  onArtifactChange: (
    artifactId: string,
    patch: Partial<ArtifactRow>,
    message?: string
  ) => void;
}) {
  const value = artifact.customValues[field.id];
  const values = customValueStrings(value);
  const updateValue = (nextValue: string | number | readonly string[] | null) =>
    onArtifactChange(artifact.id, {
      customValues: { ...artifact.customValues, [field.id]: nextValue },
    });
  switch (field.type) {
    case "Single-select": {
      const selected = values[0];
      return (
        <EditableChoiceCell
          field={field}
          onChange={(nextValue) => updateValue(nextValue)}
          values={selected ? [selected] : []}
        />
      );
    }
    case "Multi-select":
      return (
        <EditableChoiceCell
          field={field}
          multiple
          onChange={updateValue}
          values={values}
        />
      );
    case "Date":
      return (
        <EditableScalarCell
          ariaLabel={`Edit ${field.label} for ${artifact.slug}`}
          kind="date"
          onChange={updateValue}
          value={values[0] ?? ""}
        />
      );
    case "People":
      return (
        <EditableOwnerTableCell
          onChange={(person) => updateValue(person.name)}
          options={artifactPeople}
          owner={
            values[0]
              ? (artifactPeople.find((person) => person.name === values[0]) ??
                null)
              : null
          }
        />
      );
    case "Reference":
    case "Reference (multi)":
      return (
        <EditableReferenceFieldCell
          field={field}
          onChange={updateValue}
          values={values}
        />
      );
    case "Time":
      return (
        <EditableScalarCell
          ariaLabel={`Edit ${field.label} for ${artifact.slug}`}
          kind="time"
          onChange={updateValue}
          value={values[0] ?? ""}
        />
      );
    case "Text":
      return (
        <EditableScalarCell
          ariaLabel={`Edit ${field.label} for ${artifact.slug}`}
          kind="text"
          onChange={updateValue}
          value={values[0] ?? ""}
        />
      );
    case "Number":
      return (
        <EditableScalarCell
          ariaLabel={`Edit ${field.label} for ${artifact.slug}`}
          kind="number"
          onChange={updateValue}
          value={value == null ? "" : String(value)}
        />
      );
    default:
      return null;
  }
}

export function initialCustomFieldValue(
  field: CustomFieldDefinition,
  artifact: ArtifactRow,
  rowIndex: number
): string | number | readonly string[] | null {
  if (rowIndex === 2) {
    return null;
  }
  switch (field.type) {
    case "Single-select":
      return field.options?.[rowIndex % (field.options.length || 1)] ?? null;
    case "Multi-select":
      return field.options?.slice(0, 2) ?? [];
    case "Date":
      return rowIndex === 0 ? "2026-08-13" : "2026-08-09";
    case "People":
      return artifact.owner.name;
    case "Reference":
      return field.sources?.includes("Artifacts")
        ? ["FEA-2481", "BRN-grid-table-v2", "SES-7B91"]
        : "FEA-2481";
    case "Reference (multi)":
      return ["FEA-2481", "BRN-grid-table-v2", "SES-7B91"];
    case "Time":
      return rowIndex === 0 ? "02:14" : "00:48";
    case "Text":
      return "Custom text value";
    case "Number":
      return 184 + rowIndex * 37;
    default:
      return null;
  }
}

function EditableChoiceCell({
  field,
  multiple = false,
  onChange,
  values,
}: {
  field: CustomFieldDefinition;
  multiple?: boolean;
  onChange: (value: string | readonly string[] | null) => void;
  values: readonly string[];
}) {
  const options = field.options ?? [];
  const trigger = multiple ? (
    <TableChoiceListCell choices={choiceItems(field, values)} />
  ) : (
    <TableChoiceCell
      className={customOptionClassName(field, values[0])}
      label={values[0]}
    />
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit ${field.label}, currently ${values.join(", ") || "empty"}`}
          className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-muted"
          type="button"
        >
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>{field.label}</DropdownMenuLabel>
        {multiple ? (
          options.map((option) => (
            <DropdownMenuCheckboxItem
              checked={values.includes(option)}
              key={option}
              onCheckedChange={() => onChange(toggleListValue(values, option))}
              onSelect={(event) => event.preventDefault()}
            >
              <TableChoiceCell
                className={customOptionClassName(field, option)}
                label={option}
              />
            </DropdownMenuCheckboxItem>
          ))
        ) : (
          <DropdownMenuRadioGroup
            onValueChange={(nextValue) => onChange(nextValue)}
            value={values[0] ?? ""}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                <TableChoiceCell
                  className={customOptionClassName(field, option)}
                  label={option}
                />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditableScalarCell({
  ariaLabel,
  kind,
  onChange,
  value,
}: {
  ariaLabel: string;
  kind: "date" | "number" | "text" | "time";
  onChange: (value: string | number | null) => void;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const finish = (commit: boolean) => {
    if (commit) {
      const nextValue = scalarInputValue(kind, draft);
      if (nextValue !== undefined) {
        onChange(nextValue);
      }
    } else {
      setDraft(value);
    }
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        aria-label={ariaLabel}
        autoFocus
        className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onBlur={() => finish(true)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            finish(true);
          } else if (event.key === "Escape") {
            finish(false);
          }
        }}
        type={kind}
        value={draft}
      />
    );
  }
  return (
    <button
      aria-label={ariaLabel}
      className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-muted"
      onClick={() => setEditing(true)}
      type="button"
    >
      {renderScalarValue(kind, value)}
    </button>
  );
}

function renderScalarValue(
  kind: "date" | "number" | "text" | "time",
  value: string
) {
  switch (kind) {
    case "date":
      return <TableDateCell fullValue={value} value={formatDateValue(value)} />;
    case "number":
      return <TableNumberCell value={value} />;
    case "time":
      return <TableNumberCell alignEnd={false} value={value} />;
    default:
      return <TableTextCell value={value} />;
  }
}

function scalarInputValue(
  kind: "date" | "number" | "text" | "time",
  value: string
): string | number | null | undefined {
  if (!value) {
    return null;
  }
  if (kind !== "number") {
    return value;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function choiceItems(field: CustomFieldDefinition, values: readonly string[]) {
  return values.map((label) => ({
    className: customOptionClassName(field, label),
    id: label,
    label,
  }));
}

function formatDateValue(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return formatDate(date);
}

function customOptionClassName(
  field: CustomFieldDefinition,
  label: string | undefined
): string | undefined {
  const color = field.optionColors?.[field.options?.indexOf(label ?? "") ?? -1];
  switch (color) {
    case "bg-success":
      return "border-success/25 bg-success/12 text-success";
    case "bg-warning":
      return "border-warning/25 bg-warning/12 text-warning";
    case "bg-primary":
      return "border-primary/25 bg-primary/12 text-primary";
    default:
      return undefined;
  }
}

function customValueStrings(
  value: string | number | readonly string[] | null | undefined
): string[] {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (value == null) {
    return [];
  }
  return [String(value)];
}
