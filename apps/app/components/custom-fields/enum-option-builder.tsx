"use client";

import type {
  CreateEnumOptionInput,
  CustomFieldEnumOption,
} from "@repo/api/src/types/custom-field";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { MoreHorizontal, Plus } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import {
  useCreateEnumOption,
  useCustomFieldEnumOptions,
  useUpdateEnumOption,
} from "@/hooks/queries/use-custom-fields";
import type { ColorName } from "./color-picker";
import { ColorPicker } from "./color-picker";

// ---------------------------------------------------------------------------
// Local option type used in create mode
// ---------------------------------------------------------------------------

type LocalEnumOption = {
  /** Stable key for React. */
  id: string;
  name: string;
  color: ColorName | null;
  enabled: boolean;
};

// ---------------------------------------------------------------------------
// Row component (used in both modes)
// ---------------------------------------------------------------------------

type EnumOptionRowProps = {
  id: string;
  name: string;
  color: ColorName | null;
  enabled: boolean;
  onRename: (name: string) => void;
  onColorChange: (color: ColorName | null) => void;
  onDisable: () => void;
  onDelete: () => void;
};

function EnumOptionRow({
  id,
  name,
  color,
  enabled,
  onRename,
  onColorChange,
  onDisable,
  onDelete,
}: Readonly<EnumOptionRowProps>) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const isCommitting = useRef(false);

  const handleRenameCommit = () => {
    if (isCommitting.current) {
      return;
    }
    isCommitting.current = true;

    const trimmed = draftName.trim();
    if (trimmed && trimmed !== name) {
      onRename(trimmed);
    } else {
      setDraftName(name);
    }
    setIsRenaming(false);
    isCommitting.current = false;
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleRenameCommit();
    }
    if (e.key === "Escape") {
      setDraftName(name);
      setIsRenaming(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md py-1" id={id}>
      {/* Color picker dot */}
      <ColorPicker onChange={onColorChange} value={color} />

      {/* Name input or label */}
      {isRenaming ? (
        <Input
          autoFocus
          className="h-7 flex-1 text-sm"
          onBlur={handleRenameCommit}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          value={draftName}
        />
      ) : (
        <span
          className={
            enabled
              ? "flex-1 truncate text-sm"
              : "flex-1 truncate text-muted-foreground text-sm line-through"
          }
        >
          {name}
        </span>
      )}

      {/* Actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="shrink-0 text-muted-foreground hover:text-foreground"
            type="button"
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Option actions</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setDraftName(name);
              setIsRenaming(true);
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              /* ColorPicker is always accessible on the row — this is a shortcut hint. */
            }}
          >
            Change Color
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDisable}>
            {enabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} variant="destructive">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create mode (local state, no API calls)
// ---------------------------------------------------------------------------

type CreateModeProps = {
  value: CreateEnumOptionInput[];
  onChange: (options: CreateEnumOptionInput[]) => void;
};

function CreateModeBuilder({ value, onChange }: Readonly<CreateModeProps>) {
  const [localOptions, setLocalOptions] = useState<LocalEnumOption[]>(() =>
    value.map((opt, i) => ({
      id: `local-${i}-${Date.now()}`,
      name: opt.name,
      color: (opt.color as ColorName | null) ?? null,
      enabled: opt.enabled ?? true,
    }))
  );

  const idPrefix = useId();

  const syncToParent = (updated: LocalEnumOption[]) => {
    onChange(
      updated.map((opt) => ({
        name: opt.name,
        color: opt.color ?? undefined,
        enabled: opt.enabled,
        sortOrder: undefined,
      }))
    );
  };

  const updateOption = (id: string, patch: Partial<LocalEnumOption>) => {
    const updated = localOptions.map((opt) =>
      opt.id === id ? { ...opt, ...patch } : opt
    );
    setLocalOptions(updated);
    syncToParent(updated);
  };

  const deleteOption = (id: string) => {
    const updated = localOptions.filter((opt) => opt.id !== id);
    setLocalOptions(updated);
    syncToParent(updated);
  };

  const addOption = () => {
    const newOption: LocalEnumOption = {
      id: `${idPrefix}-${Date.now()}`,
      name: "New Option",
      color: null,
      enabled: true,
    };
    const updated = [...localOptions, newOption];
    setLocalOptions(updated);
    syncToParent(updated);
  };

  return (
    <div className="space-y-1">
      {localOptions.map((opt) => (
        <EnumOptionRow
          color={opt.color}
          enabled={opt.enabled}
          id={opt.id}
          key={opt.id}
          name={opt.name}
          onColorChange={(color) => updateOption(opt.id, { color })}
          onDelete={() => deleteOption(opt.id)}
          onDisable={() => updateOption(opt.id, { enabled: !opt.enabled })}
          onRename={(name) => updateOption(opt.id, { name })}
        />
      ))}

      <Button
        className="mt-2 w-full"
        onClick={addOption}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="h-4 w-4" />
        Add option
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit mode (API-backed, fieldId required)
// ---------------------------------------------------------------------------

type EditModeProps = {
  fieldId: string;
};

function EditModeBuilder({ fieldId }: Readonly<EditModeProps>) {
  const { data: options = [] } = useCustomFieldEnumOptions(fieldId);
  const updateOption = useUpdateEnumOption(fieldId);
  const createOption = useCreateEnumOption(fieldId);

  const displayOptions = useMemo(
    () => [...options].sort((a, b) => a.sortOrder - b.sortOrder),
    [options]
  );

  const handleAddOption = () => {
    createOption.mutate({
      name: "New Option",
      enabled: true,
      sortOrder: displayOptions.length,
    });
  };

  return (
    <div className="space-y-1">
      {displayOptions.map((opt: CustomFieldEnumOption) => (
        <EnumOptionRow
          color={(opt.color as ColorName | null) ?? null}
          enabled={opt.enabled}
          id={opt.id}
          key={opt.id}
          name={opt.name}
          onColorChange={(color) =>
            updateOption.mutate({
              optionId: opt.id,
              color: color ?? undefined,
            })
          }
          onDelete={() =>
            updateOption.mutate({ optionId: opt.id, enabled: false })
          }
          onDisable={() =>
            updateOption.mutate({ optionId: opt.id, enabled: !opt.enabled })
          }
          onRename={(name) => updateOption.mutate({ optionId: opt.id, name })}
        />
      ))}

      <Button
        className="mt-2 w-full"
        disabled={createOption.isPending}
        onClick={handleAddOption}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="h-4 w-4" />
        Add option
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component — switches between create/edit mode
// ---------------------------------------------------------------------------

type EnumOptionBuilderCreateProps = {
  fieldId?: undefined;
  value: CreateEnumOptionInput[];
  onChange: (options: CreateEnumOptionInput[]) => void;
};

type EnumOptionBuilderEditProps = {
  fieldId: string;
  value?: undefined;
  onChange?: undefined;
};

export type EnumOptionBuilderProps =
  | EnumOptionBuilderCreateProps
  | EnumOptionBuilderEditProps;

export function EnumOptionBuilder(props: EnumOptionBuilderProps) {
  if ("fieldId" in props && props.fieldId) {
    return <EditModeBuilder fieldId={props.fieldId} />;
  }
  const createProps = props as EnumOptionBuilderCreateProps;
  return (
    <CreateModeBuilder
      onChange={createProps.onChange}
      value={createProps.value}
    />
  );
}
