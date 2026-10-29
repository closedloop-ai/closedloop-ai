"use client";

import type { LucideIcon } from "lucide-react";
import {
  ALargeSmallIcon,
  CalendarDaysIcon,
  CircleChevronDownIcon,
  Clock3Icon,
  HashIcon,
  Link2Icon,
  LinkIcon,
  PlusIcon,
  SquareCheckIcon,
  UserRoundIcon,
} from "lucide-react";
import { Button } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { DialogFooter } from "./dialog";
import { Input } from "./input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { TABLE_FIELD_OPTION_COLORS } from "./table-add-field-dialog-colors";
import {
  FieldOptionsEditor,
  ReferenceSourceSelector,
} from "./table-add-field-dialog-fields";

export const TableCustomFieldType = {
  SingleSelect: "Single-select",
  MultiSelect: "Multi-select",
  Date: "Date",
  People: "People",
  Reference: "Reference",
  ReferenceMulti: "Reference (multi)",
  Time: "Time",
  Text: "Text",
  Number: "Number",
} as const;
export type TableCustomFieldType =
  (typeof TableCustomFieldType)[keyof typeof TableCustomFieldType];

export const TableCustomFieldTimeFormat = {
  Duration: "duration",
  Decimal: "decimal",
  Minutes: "minutes",
} as const;
export type TableCustomFieldTimeFormat =
  (typeof TableCustomFieldTimeFormat)[keyof typeof TableCustomFieldTimeFormat];

export const TABLE_CUSTOM_FIELD_TYPES = Object.values(TableCustomFieldType);

export type TableCustomFieldDefinition = {
  id: string;
  label: string;
  type: TableCustomFieldType;
  description?: string;
  options?: string[];
  optionColors?: string[];
  sources?: string[];
  timeFormat?: TableCustomFieldTimeFormat;
};

export type TableCustomFieldDraft = Omit<TableCustomFieldDefinition, "id">;

export type TableCustomFieldReferenceSource = {
  icon: LucideIcon;
  label: string;
  value: string;
};

export type TableExistingCustomFieldOption = {
  description?: string;
  id: string;
  label: string;
  typeLabel: string;
};

const TYPE_ICONS: Record<TableCustomFieldType, LucideIcon> = {
  [TableCustomFieldType.SingleSelect]: CircleChevronDownIcon,
  [TableCustomFieldType.MultiSelect]: SquareCheckIcon,
  [TableCustomFieldType.Date]: CalendarDaysIcon,
  [TableCustomFieldType.People]: UserRoundIcon,
  [TableCustomFieldType.Reference]: Link2Icon,
  [TableCustomFieldType.ReferenceMulti]: LinkIcon,
  [TableCustomFieldType.Time]: Clock3Icon,
  [TableCustomFieldType.Text]: ALargeSmallIcon,
  [TableCustomFieldType.Number]: HashIcon,
};

export function ExistingFieldPicker({
  error,
  fields,
  onCreate,
  onSelect,
  selectingFieldId,
}: {
  error: string | null;
  fields: readonly TableExistingCustomFieldOption[];
  onCreate: () => void;
  onSelect: (fieldId: string) => void;
  selectingFieldId: string | null;
}) {
  return (
    <>
      <Command className="min-h-0 rounded-none" label="Search fields">
        <CommandInput autoFocus placeholder="Search fields…" />
        <CommandList className="max-h-80 px-2 py-2">
          <CommandEmpty>No fields found</CommandEmpty>
          <CommandGroup heading="Existing fields">
            {fields.map((field) => (
              <CommandItem
                disabled={selectingFieldId !== null}
                key={field.id}
                onSelect={() => onSelect(field.id)}
                value={`${field.label} ${field.typeLabel}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{field.label}</span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {field.typeLabel}
                    {field.description ? ` · ${field.description}` : ""}
                  </span>
                </span>
                {selectingFieldId === field.id ? (
                  <span className="text-muted-foreground text-xs">Adding…</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
      {error ? (
        <p className="px-6 pb-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <DialogFooter className="shrink-0 border-t px-6 py-4">
        <Button
          disabled={selectingFieldId !== null}
          onClick={onCreate}
          type="button"
        >
          <PlusIcon />
          Create new field
        </Button>
      </DialogFooter>
    </>
  );
}

export function CreateFieldForm({
  availableFieldTypes,
  canCreate,
  description,
  descriptionOpen,
  formId,
  hasExistingFieldPicker,
  isCreating,
  onBack,
  onCancel,
  onCreate,
  optionColorIndexes,
  options,
  referenceSources,
  setDescription,
  setDescriptionOpen,
  setOptionColorIndexes,
  setOptions,
  setSource,
  setSubmitError,
  setTimeFormat,
  setTitle,
  setType,
  source,
  submitError,
  timeFormat,
  title,
  type,
}: {
  availableFieldTypes: readonly TableCustomFieldType[];
  canCreate: boolean;
  description: string;
  descriptionOpen: boolean;
  formId: string;
  hasExistingFieldPicker: boolean;
  isCreating: boolean;
  onBack: () => void;
  onCancel: () => void;
  onCreate: () => void;
  optionColorIndexes: readonly number[];
  options: readonly string[];
  referenceSources: readonly TableCustomFieldReferenceSource[];
  setDescription: (value: string) => void;
  setDescriptionOpen: (value: boolean) => void;
  setOptionColorIndexes: (value: number[]) => void;
  setOptions: (value: string[]) => void;
  setSource: (value: string) => void;
  setSubmitError: (value: string | null) => void;
  setTimeFormat: (value: TableCustomFieldTimeFormat) => void;
  setTitle: (value: string) => void;
  setType: (value: TableCustomFieldType) => void;
  source: string;
  submitError: string | null;
  timeFormat: TableCustomFieldTimeFormat;
  title: string;
  type: TableCustomFieldType;
}) {
  const TypeIcon = TYPE_ICONS[type];
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.75fr)_minmax(260px,1fr)]">
          <div>
            <label className="font-medium text-sm" htmlFor={`${formId}-title`}>
              Field title <span className="text-destructive">*</span>
            </label>
            <Input
              className="mt-2"
              id={`${formId}-title`}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Priority, Stage, Status…"
              value={title}
            />
            {descriptionOpen ? (
              <Input
                aria-label="Field description"
                className="mt-2"
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe this field…"
                value={description}
              />
            ) : (
              <button
                className="mt-2 flex items-center gap-2 px-1 text-left text-muted-foreground text-sm hover:text-foreground"
                onClick={() => setDescriptionOpen(true)}
                type="button"
              >
                <PlusIcon className="size-4" />
                Add description
              </button>
            )}
          </div>

          <div>
            <label className="font-medium text-sm" htmlFor={`${formId}-type`}>
              Field type
            </label>
            <Select
              onValueChange={(value) => {
                const nextType = value as TableCustomFieldType;
                setType(nextType);
                setSubmitError(null);
                if (!isReferenceType(nextType)) {
                  setSource("");
                }
              }}
              value={type}
            >
              <SelectTrigger className="mt-2 w-full" id={`${formId}-type`}>
                <SelectValue>
                  <TypeIcon />
                  {type}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                {availableFieldTypes.map((fieldType) => {
                  const Icon = TYPE_ICONS[fieldType];
                  return (
                    <SelectItem key={fieldType} value={fieldType}>
                      <Icon />
                      {fieldType}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isChoiceType(type) ? (
          <FieldOptionsEditor
            onColorIndexesChange={setOptionColorIndexes}
            onOptionsChange={setOptions}
            optionColorIndexes={optionColorIndexes}
            options={options}
          />
        ) : null}

        {isReferenceType(type) ? (
          <ReferenceSourceSelector
            formId={formId}
            multiple={type === TableCustomFieldType.ReferenceMulti}
            onChange={setSource}
            sources={referenceSources}
            value={source}
          />
        ) : null}

        {type === TableCustomFieldType.Time ? (
          <TimeFormatSelector onChange={setTimeFormat} value={timeFormat} />
        ) : null}

        {submitError ? (
          <p className="mt-6 text-destructive text-sm" role="alert">
            {submitError}
          </p>
        ) : null}
      </div>

      <DialogFooter className="shrink-0 border-t px-6 py-4">
        <Button
          disabled={isCreating}
          onClick={hasExistingFieldPicker ? onBack : onCancel}
          type="button"
          variant="outline"
        >
          {hasExistingFieldPicker ? "Back" : "Cancel"}
        </Button>
        <Button disabled={!canCreate} onClick={onCreate} type="button">
          {isCreating ? "Creating…" : "Create field"}
        </Button>
      </DialogFooter>
    </>
  );
}

function TimeFormatSelector({
  onChange,
  value,
}: {
  onChange: (value: TableCustomFieldTimeFormat) => void;
  value: TableCustomFieldTimeFormat;
}) {
  return (
    <section className="mt-8">
      <h3 className="font-medium text-sm">Format</h3>
      <Select
        onValueChange={(nextValue) =>
          onChange(nextValue as TableCustomFieldTimeFormat)
        }
        value={value}
      >
        <SelectTrigger className="mt-2 w-48 tabular-nums">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value={TableCustomFieldTimeFormat.Duration}>
            00h 00m
          </SelectItem>
          <SelectItem value={TableCustomFieldTimeFormat.Decimal}>
            0.00 hours
          </SelectItem>
          <SelectItem value={TableCustomFieldTimeFormat.Minutes}>
            000 minutes
          </SelectItem>
        </SelectContent>
      </Select>
    </section>
  );
}

export function buildFieldDraft({
  description,
  optionColorIndexes,
  options,
  source,
  timeFormat,
  title,
  type,
}: {
  description: string;
  optionColorIndexes: readonly number[];
  options: readonly string[];
  source: string;
  timeFormat: TableCustomFieldTimeFormat;
  title: string;
  type: TableCustomFieldType;
}): TableCustomFieldDraft {
  const populatedOptions = options
    .map((option, index) => ({ index, value: option.trim() }))
    .filter(({ value }) => value.length > 0);
  return {
    description: description.trim() || undefined,
    label: title.trim(),
    optionColors: isChoiceType(type)
      ? populatedOptions.map(
          ({ index }) =>
            TABLE_FIELD_OPTION_COLORS[optionColorIndexes[index] ?? 0]
        )
      : undefined,
    options: isChoiceType(type)
      ? populatedOptions.map(({ value }) => value)
      : undefined,
    sources: isReferenceType(type) ? [source] : undefined,
    timeFormat:
      type === TableCustomFieldType.Time ? timeFormat : undefined,
    type,
  };
}

export function isChoiceType(type: TableCustomFieldType): boolean {
  return (
    type === TableCustomFieldType.SingleSelect ||
    type === TableCustomFieldType.MultiSelect
  );
}

export function isReferenceType(type: TableCustomFieldType): boolean {
  return (
    type === TableCustomFieldType.Reference ||
    type === TableCustomFieldType.ReferenceMulti
  );
}
