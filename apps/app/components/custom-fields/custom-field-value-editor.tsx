"use client";

import type {
  CustomFieldEntityType,
  CustomFieldEnumOption,
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUpdateCustomFieldValue } from "@/hooks/queries/use-custom-fields";
import { getUserDisplayName } from "@/lib/user-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BaseEditorProps = {
  fieldId: string;
  entityType: CustomFieldEntityType;
  entityId: string;
};

// ---------------------------------------------------------------------------
// TextFieldEditor — blur-to-save Input
// ---------------------------------------------------------------------------

type TextFieldEditorProps = BaseEditorProps & {
  initialValue: string | null;
};

function TextFieldEditor({
  fieldId,
  entityType,
  entityId,
  initialValue,
}: Readonly<TextFieldEditorProps>) {
  const [text, setText] = useState(initialValue ?? "");
  const focusedRef = useRef(false);
  const mutation = useUpdateCustomFieldValue(entityType, entityId);

  // Sync from server when value changes, but only when not actively editing
  useEffect(() => {
    if (!focusedRef.current) {
      setText(initialValue ?? "");
    }
  }, [initialValue]);

  const handleBlur = () => {
    focusedRef.current = false;
    const value = text.trim() === "" ? null : text.trim();
    mutation.mutate({ fieldId, value });
  };

  return (
    <Input
      onBlur={handleBlur}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      placeholder="Enter text..."
      value={text}
    />
  );
}

// ---------------------------------------------------------------------------
// NumberFieldEditor — formatted display when unfocused, raw number when editing
// ---------------------------------------------------------------------------

type NumberFieldEditorProps = BaseEditorProps & {
  initialValue: number | null;
  displayValue: string | null;
  numberFormat: string | null;
  precision: number | null;
  customLabel: string | null;
  customLabelPosition: string | null;
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

function NumberFieldEditor({
  fieldId,
  entityType,
  entityId,
  initialValue,
  displayValue,
  numberFormat,
  precision,
  customLabel,
  customLabelPosition,
}: Readonly<NumberFieldEditorProps>) {
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState(
    initialValue === null ? "" : String(initialValue)
  );
  const mutation = useUpdateCustomFieldValue(entityType, entityId);

  // Sync from server when value changes, but only when not actively editing
  useEffect(() => {
    if (!focused) {
      setRaw(initialValue === null ? "" : String(initialValue));
    }
  }, [initialValue, focused]);

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
    setFocused(false);
    const parsed = raw === "" ? null : Number.parseFloat(raw);
    const value = parsed !== null && !Number.isNaN(parsed) ? parsed : null;
    mutation.mutate({ fieldId, value });
  };

  return (
    <div className="flex items-center gap-1">
      {prefix && (
        <span className="shrink-0 text-muted-foreground text-sm">{prefix}</span>
      )}
      <Input
        onBlur={handleBlur}
        onChange={(e) => setRaw(e.target.value)}
        onFocus={() => setFocused(true)}
        placeholder="0"
        type="text"
        value={focused ? raw : displayText}
      />
      {suffix && (
        <span className="shrink-0 text-muted-foreground text-sm">{suffix}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EnumFieldEditor — Select with colored dot per option
// ---------------------------------------------------------------------------

type EnumFieldEditorProps = BaseEditorProps & {
  initialEnumValue: CustomFieldEnumOption | null;
  options: CustomFieldEnumOption[];
};

function ColorDot({ color }: Readonly<{ color: string }>) {
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function EnumFieldEditor({
  fieldId,
  entityType,
  entityId,
  initialEnumValue,
  options,
}: Readonly<EnumFieldEditorProps>) {
  const [selectedId, setSelectedId] = useState<string | null>(
    initialEnumValue?.id ?? null
  );
  const mutation = useUpdateCustomFieldValue(entityType, entityId);
  const activeOptions = options.filter((o) => o.enabled);

  // Sync from server when value changes
  useEffect(() => {
    setSelectedId(initialEnumValue?.id ?? null);
  }, [initialEnumValue?.id]);

  const selectedOption = selectedId
    ? (options.find((o) => o.id === selectedId) ?? null)
    : null;

  const handleChange = (optionId: string) => {
    const value = optionId === "__none__" ? null : optionId;
    const previousId = selectedId;
    setSelectedId(value);
    mutation.mutate(
      { fieldId, value },
      {
        onError: () => {
          setSelectedId(previousId);
        },
      }
    );
  };

  return (
    <Select onValueChange={handleChange} value={selectedId ?? "__none__"}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select option...">
          {selectedOption ? (
            <div className="flex items-center gap-2">
              <ColorDot color={selectedOption.color} />
              <span>{selectedOption.name}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">Select option...</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">
          <span className="text-muted-foreground">None</span>
        </SelectItem>
        {activeOptions.map((opt) => (
          <SelectItem key={opt.id} value={opt.id}>
            <div className="flex items-center gap-2">
              <ColorDot color={opt.color} />
              <span>{opt.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// MultiEnumFieldEditor — Popover checkbox list + Badge pills with x to remove
// ---------------------------------------------------------------------------

type MultiEnumFieldEditorProps = BaseEditorProps & {
  initialValues: CustomFieldEnumOption[];
  options: CustomFieldEnumOption[];
};

function MultiEnumFieldEditor({
  fieldId,
  entityType,
  entityId,
  initialValues,
  options,
}: Readonly<MultiEnumFieldEditorProps>) {
  const [selected, setSelected] = useState<string[]>(
    initialValues.map((v) => v.id)
  );
  const [open, setOpen] = useState(false);
  const mutation = useUpdateCustomFieldValue(entityType, entityId);
  const activeOptions = options.filter((o) => o.enabled);
  const initialIdKey = initialValues.map((v) => v.id).join(",");

  // Sync from server when values change (use stable string key to avoid infinite re-renders)
  useEffect(() => {
    if (!open) {
      setSelected(initialIdKey ? initialIdKey.split(",") : []);
    }
  }, [initialIdKey, open]);

  const toggleOption = (optionId: string, checked: boolean) => {
    const next = checked
      ? [...selected, optionId]
      : selected.filter((id) => id !== optionId);
    setSelected(next);
    mutation.mutate({ fieldId, value: next });
  };

  const removeValue = (optionId: string) => {
    const next = selected.filter((id) => id !== optionId);
    setSelected(next);
    mutation.mutate({ fieldId, value: next });
  };

  const selectedOptions = activeOptions.filter((o) => selected.includes(o.id));

  return (
    <div className="flex flex-col gap-2">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="w-full justify-start text-left font-normal"
            variant="outline"
          >
            {selected.length === 0 ? (
              <span className="text-muted-foreground">Select options...</span>
            ) : (
              <span>{selected.length} selected</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-2">
          <div className="flex flex-col gap-1">
            {activeOptions.map((opt) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                htmlFor={`multi-enum-${opt.id}`}
                key={opt.id}
              >
                <Checkbox
                  checked={selected.includes(opt.id)}
                  id={`multi-enum-${opt.id}`}
                  onCheckedChange={(checked) =>
                    toggleOption(opt.id, checked === true)
                  }
                />
                <ColorDot color={opt.color} />
                <span className="text-sm">{opt.name}</span>
              </label>
            ))}
            {activeOptions.length === 0 && (
              <span className="px-2 py-1 text-muted-foreground text-sm">
                No options available
              </span>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedOptions.map((opt) => (
            <Badge
              className="flex items-center gap-1 pr-1"
              key={opt.id}
              variant="secondary"
            >
              <ColorDot color={opt.color} />
              <span>{opt.name}</span>
              <button
                className="ml-0.5 hover:opacity-70"
                onClick={() => removeValue(opt.id)}
                type="button"
              >
                <XIcon className="size-3" />
                <span className="sr-only">Remove {opt.name}</span>
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateFieldEditor — reuses DatePickerPopover
// ---------------------------------------------------------------------------

type DateFieldEditorProps = BaseEditorProps & {
  initialValue: Date | null;
};

function DateFieldEditor({
  fieldId,
  entityType,
  entityId,
  initialValue,
}: Readonly<DateFieldEditorProps>) {
  const [date, setDate] = useState<Date | null>(initialValue);
  const mutation = useUpdateCustomFieldValue(entityType, entityId);
  const dateKey = initialValue?.getTime() ?? null;

  // Sync from server when value changes (use stable primitive dep to avoid re-firing on every render)
  useEffect(() => {
    setDate(dateKey === null ? null : new Date(dateKey));
  }, [dateKey]);

  const handleSelect = (selected: Date | null) => {
    setDate(selected);
    const value = selected ? selected.toISOString() : null;
    mutation.mutate({ fieldId, value });
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

// ---------------------------------------------------------------------------
// PeopleFieldEditor — multi-select of org users (MVP: display + add via popover)
// ---------------------------------------------------------------------------

type PeopleFieldEditorProps = BaseEditorProps & {
  initialPeople: BasicUser[];
};

function PeopleFieldEditor({
  fieldId,
  entityType,
  entityId,
  initialPeople,
}: Readonly<PeopleFieldEditorProps>) {
  const [selected, setSelected] = useState<BasicUser[]>(initialPeople);
  const mutation = useUpdateCustomFieldValue(entityType, entityId);
  const initialPeopleKey = initialPeople.map((u) => u.id).join(",");

  // Sync from server when people change (use stable string key to avoid infinite re-renders)
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialPeople array ref changes each render; use stable key instead
  useEffect(() => {
    setSelected(initialPeople);
  }, [initialPeopleKey]);

  const removeUser = (userId: string) => {
    const next = selected.filter((u) => u.id !== userId);
    setSelected(next);
    mutation.mutate({ fieldId, value: next.map((u) => u.id) });
  };

  if (selected.length === 0) {
    return (
      <span className="text-muted-foreground text-sm">No people assigned</span>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {selected.map((user) => (
        <Badge
          className="flex items-center gap-1 pr-1"
          key={user.id}
          variant="secondary"
        >
          <span>{getUserDisplayName(user)}</span>
          <button
            className="ml-0.5 hover:opacity-70"
            onClick={() => removeUser(user.id)}
            type="button"
          >
            <XIcon className="size-3" />
            <span className="sr-only">Remove {getUserDisplayName(user)}</span>
          </button>
        </Badge>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CustomFieldValueEditor — parent switch-dispatcher
// ---------------------------------------------------------------------------

export type CustomFieldValueEditorProps = {
  entityType: CustomFieldEntityType;
  entityId: string;
  setting: CustomFieldSettingWithOptions;
  /** Optional resolved value; omit when value is not yet loaded. */
  value?: CustomFieldValueDetail;
};

export function CustomFieldValueEditor({
  entityType,
  entityId,
  setting,
  value,
}: Readonly<CustomFieldValueEditorProps>) {
  const { customField } = setting;
  const { id: fieldId, fieldType } = customField;
  const enumOptions = customField.enumOptions ?? [];

  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs">
        {customField.name}
      </span>

      {fieldType === CustomFieldType.Text && (
        <TextFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={fieldId}
          initialValue={value?.textValue ?? null}
        />
      )}

      {fieldType === CustomFieldType.Number && (
        <NumberFieldEditor
          customLabel={customField.customLabel}
          customLabelPosition={customField.customLabelPosition}
          displayValue={value?.displayValue ?? null}
          entityId={entityId}
          entityType={entityType}
          fieldId={fieldId}
          initialValue={value?.numberValue ?? null}
          numberFormat={customField.numberFormat}
          precision={customField.precision}
        />
      )}

      {fieldType === CustomFieldType.Enum && (
        <EnumFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={fieldId}
          initialEnumValue={value?.enumValue ?? null}
          options={enumOptions}
        />
      )}

      {fieldType === CustomFieldType.MultiEnum && (
        <MultiEnumFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={fieldId}
          initialValues={value?.multiEnumValues ?? []}
          options={enumOptions}
        />
      )}

      {fieldType === CustomFieldType.Date && (
        <DateFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={fieldId}
          initialValue={value?.dateValue ? new Date(value.dateValue) : null}
        />
      )}

      {fieldType === CustomFieldType.People && (
        <PeopleFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={fieldId}
          initialPeople={value?.peopleValues ?? []}
        />
      )}
    </div>
  );
}
