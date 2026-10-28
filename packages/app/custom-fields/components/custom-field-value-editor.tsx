"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  CustomFieldEntityType,
  CustomFieldEnumOption,
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { useUpdateCustomFieldValue } from "@repo/app/custom-fields/hooks/use-custom-fields";
import { isDurationFormattedField } from "@repo/app/custom-fields/lib/duration-field";
import { knownCustomFieldOptionColorClass } from "@repo/app/custom-fields/lib/option-colors";
import {
  CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
  CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
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
import { cn } from "@repo/design-system/lib/utils";
import {
  CustomFieldEditor,
  resolveCustomFieldEditor,
} from "@repo/lib/custom-fields/custom-field-editor";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import type { BaseEditorProps } from "./custom-field-editor-props";
import { renderScalarCustomFieldEditor } from "./custom-field-scalar-editor";

// EnumFieldEditor — Select with colored dot per option

type EnumFieldEditorProps = BaseEditorProps & {
  initialEnumValue: CustomFieldEnumOption | null;
  options: CustomFieldEnumOption[];
};

/**
 * The persisted option colour.
 *
 * Feeding the stored value straight to CSS made a canonical id like `green`
 * paint `#008000` while the picker two components away painted `bg-green-500` —
 * one option, two greens on one screen — and a legacy `bg-success` was not a
 * colour at all, so the dot vanished. Gated, a value from the palette is drawn
 * from the same class map the picker reads.
 *
 * The inline style stays for everything else, deliberately: `color` is an
 * unconstrained string server-side and a row can hold a raw `#ff0000`, so
 * narrowing this to the palette would stop rendering a colour it shows today
 * (ISS-8215).
 */
function ColorDot({ color }: Readonly<{ color: string }>) {
  const canonicalColors = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY
  );
  const paletteClass = canonicalColors
    ? knownCustomFieldOptionColorClass(color)
    : undefined;
  if (paletteClass) {
    return (
      <span
        className={cn(
          "inline-block size-2.5 shrink-0 rounded-full",
          paletteClass
        )}
      />
    );
  }
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

// Shared remove control for the pill lists (multi-enum + people). Keeps a
// focusable target with a visible focus ring and a rounded hit area rather than
// a bare opacity-hover glyph.
function RemoveValueButton({
  label,
  onRemove,
}: Readonly<{ label: string; onRemove: () => void }>) {
  return (
    <button
      className={`ml-0.5 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground ${CHIP_FOCUS_RING_CLASS}`}
      onClick={onRemove}
      type="button"
    >
      <XIcon className="size-3" />
      <span className="sr-only">Remove {label}</span>
    </button>
  );
}

function EnumFieldEditor({
  fieldId,
  entityType,
  entityId,
  surface,
  initialEnumValue,
  options,
}: Readonly<EnumFieldEditorProps>) {
  const [selectedId, setSelectedId] = useState<string | null>(
    initialEnumValue?.id ?? null
  );
  const mutation = useUpdateCustomFieldValue(entityType, entityId, surface);
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

// MultiEnumFieldEditor — Popover checkbox list + Badge pills with x to remove

type MultiEnumFieldEditorProps = BaseEditorProps & {
  initialValues: CustomFieldEnumOption[];
  options: CustomFieldEnumOption[];
};

function MultiEnumFieldEditor({
  fieldId,
  entityType,
  entityId,
  surface,
  initialValues,
  options,
}: Readonly<MultiEnumFieldEditorProps>) {
  const [selected, setSelected] = useState<string[]>(
    initialValues.map((v) => v.id)
  );
  const [open, setOpen] = useState(false);
  const mutation = useUpdateCustomFieldValue(entityType, entityId, surface);
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

  // Derive pills from the full options list (not activeOptions) so a value that
  // references a now-disabled option still renders a removable pill. Building
  // from activeOptions leaves such an id in `selected` with no pill and no
  // checkbox — an un-removable "ghost" selection.
  const selectedOptions = options.filter((o) => selected.includes(o.id));

  // Ids in the stored value that resolve to no option at all — e.g. an option
  // hard-deleted from the field. Single-enum SetNulls via its FK, but
  // multiEnumValueIds is a plain array with no referential integrity, so an
  // orphaned id would otherwise inflate the "N selected" count with no pill and
  // no way to remove it. Render them as removable "Unknown option" pills so the
  // count always matches the pills shown and every stored id can be cleared.
  const optionIds = new Set(options.map((o) => o.id));
  const orphanedIds = selected.filter((id) => !optionIds.has(id));

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

      {(selectedOptions.length > 0 || orphanedIds.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {selectedOptions.map((opt) => (
            <Badge
              className="flex items-center gap-1 pr-1"
              key={opt.id}
              variant="secondary"
            >
              <ColorDot color={opt.color} />
              <span>{opt.name}</span>
              <RemoveValueButton
                label={opt.name}
                onRemove={() => removeValue(opt.id)}
              />
            </Badge>
          ))}
          {orphanedIds.map((id) => (
            <Badge
              className="flex items-center gap-1 pr-1"
              key={id}
              variant="secondary"
            >
              <span className="text-muted-foreground">Unknown option</span>
              <RemoveValueButton
                label="unknown option"
                onRemove={() => removeValue(id)}
              />
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// PeopleFieldEditor — multi-select of org users (MVP: display + add via popover)

type PeopleFieldEditorProps = BaseEditorProps & {
  initialPeople: BasicUser[];
};

function PeopleFieldEditor({
  fieldId,
  entityType,
  entityId,
  surface,
  initialPeople,
}: Readonly<PeopleFieldEditorProps>) {
  const [selected, setSelected] = useState<BasicUser[]>(initialPeople);
  const mutation = useUpdateCustomFieldValue(entityType, entityId, surface);
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
          <RemoveValueButton
            label={getUserDisplayName(user)}
            onRemove={() => removeUser(user.id)}
          />
        </Badge>
      ))}
    </div>
  );
}

// CustomFieldValueEditor — parent dispatcher, over the ISS-9484 editor registry

export type CustomFieldValueEditorProps = {
  entityType: CustomFieldEntityType;
  entityId: string;
  surface?: ArtifactStatusEditSurface;
  setting: CustomFieldSettingWithOptions;
  /** Optional resolved value; omit when value is not yet loaded. */
  value?: CustomFieldValueDetail;
};

export function CustomFieldValueEditor({
  entityType,
  entityId,
  surface,
  setting,
  value,
}: Readonly<CustomFieldValueEditorProps>) {
  const { customField } = setting;
  // ISS-8213: read once, here, and let it pick between two whole editors. A
  // DURATION field is a NUMBER field, so `fieldType` alone cannot select the
  // right unit.
  const durationFormatEnabled = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY
  );

  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs">
        {customField.name}
      </span>

      {renderCustomFieldEditor({
        customField,
        entityId,
        entityType,
        surface,
        isDurationField:
          durationFormatEnabled === true &&
          isDurationFormattedField(customField),
        value,
      })}
    </div>
  );
}

type EditorRenderArgs = {
  customField: CustomFieldSettingWithOptions["customField"];
  entityId: string;
  entityType: CustomFieldEntityType;
  surface?: ArtifactStatusEditSurface;
  isDurationField: boolean;
  value?: CustomFieldValueDetail;
};

/**
 * ISS-9484 (#7902 review: tamsinb). The field type picks its editor through
 * the registry, exactly as the grid cell does, rather than through a chain of
 * `if`s over `fieldType` — a type added to the registry against an editor this
 * file already renders used to compile here and leave the panel showing a field
 * name with nothing under it.
 *
 * A type this build has no row for resolves to `None` and renders read-only, so
 * a peer on the other side of a rolling deploy cannot be offered an editor that
 * collects what this build cannot store.
 */
function renderCustomFieldEditor({
  customField,
  entityId,
  entityType,
  surface,
  isDurationField,
  value,
}: EditorRenderArgs): ReactNode {
  const editor = resolveCustomFieldEditor(customField.fieldType);
  switch (editor) {
    case CustomFieldEditor.Scalar:
      return renderScalarCustomFieldEditor({
        customField,
        entityId,
        entityType,
        surface,
        isDurationField,
        value,
      });
    case CustomFieldEditor.Choice:
      return renderChoiceCustomFieldEditor({
        customField,
        entityId,
        entityType,
        isDurationField,
        value,
      });
    case CustomFieldEditor.People:
      return (
        <PeopleFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={customField.id}
          initialPeople={value?.peopleValues ?? []}
          surface={surface}
        />
      );
    // The reference picker is a grid-only control today
    // (`EditableReferenceCustomFieldCell`); it needs a target search and the
    // owning entity id, neither of which this panel is given. Read-only here is
    // what shipped, not a decision taken in this file.
    case CustomFieldEditor.Reference:
      return null;
    case CustomFieldEditor.None:
      return null;
    default:
      return assertNoUnhandledEditor(editor);
  }
}

function renderChoiceCustomFieldEditor({
  customField,
  entityId,
  entityType,
  surface,
  value,
}: EditorRenderArgs): ReactNode {
  const options = customField.enumOptions ?? [];
  if (customField.fieldType === CustomFieldType.MultiEnum) {
    return (
      <MultiEnumFieldEditor
        entityId={entityId}
        entityType={entityType}
        fieldId={customField.id}
        initialValues={value?.multiEnumValues ?? []}
        options={options}
        surface={surface}
      />
    );
  }
  return (
    <EnumFieldEditor
      entityId={entityId}
      entityType={entityType}
      fieldId={customField.id}
      initialEnumValue={value?.enumValue ?? null}
      options={options}
      surface={surface}
    />
  );
}

/**
 * A sixth `CustomFieldEditor` would otherwise compile and fall silently to an
 * empty slot — the same hole the registry exists to close, one level up. The
 * grid cell carries the identical guard.
 */
function assertNoUnhandledEditor(editor: never): never {
  throw new Error(`Unhandled custom-field editor: ${String(editor)}`);
}
