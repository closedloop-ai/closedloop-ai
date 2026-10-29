"use client";

import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import type { TableCustomFieldReferenceSource } from "./table-add-field-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Input } from "./input";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { TABLE_FIELD_OPTION_COLORS } from "./table-add-field-dialog-colors";
import { cn } from "../../lib/utils";

/**
 * Compatibility re-export. This module owned `TABLE_FIELD_OPTION_COLORS` before
 * ISS-8215 moved it to `table-add-field-dialog-colors.ts`; a consumer importing
 * the old deep path keeps compiling. In-repo callers import the colours module
 * directly — this export exists for out-of-repo importers only, so removing it
 * needs the human approval the compatibility guardrail requires.
 */
export { TABLE_FIELD_OPTION_COLORS } from "./table-add-field-dialog-colors";

export function FieldOptionsEditor({
  onColorIndexesChange,
  onOptionsChange,
  optionColorIndexes,
  options,
}: {
  onColorIndexesChange: (indexes: number[]) => void;
  onOptionsChange: (options: string[]) => void;
  optionColorIndexes: readonly number[];
  options: readonly string[];
}) {
  return (
    <section className="mt-8">
      <h3 className="font-medium text-sm">
        Options <span className="text-destructive">*</span>
      </h3>
      <div className="mt-3 space-y-3">
        {options.map((option, index) => (
          <div
            className="grid grid-cols-[36px_minmax(0,1fr)_28px] items-center gap-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: option positions are stable until the user removes one
            key={index}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={`Choose color for option ${index + 1}`}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md text-primary-foreground",
                    TABLE_FIELD_OPTION_COLORS[optionColorIndexes[index] ?? 0]
                  )}
                  type="button"
                >
                  <ChevronDownIcon className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-32">
                {TABLE_FIELD_OPTION_COLORS.map((color, colorIndex) => (
                  <DropdownMenuItem
                    key={color}
                    onSelect={() =>
                      onColorIndexesChange(
                        optionColorIndexes.map((value, optionIndex) =>
                          optionIndex === index ? colorIndex : value
                        )
                      )
                    }
                  >
                    <span className={cn("size-4 rounded-sm", color)} />
                    Color {colorIndex + 1}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Input
              onChange={(event) =>
                onOptionsChange(
                  options.map((value, optionIndex) =>
                    optionIndex === index ? event.target.value : value
                  )
                )
              }
              placeholder="Type an option name"
              value={option}
            />
            <button
              aria-label={`Remove option ${index + 1}`}
              className="flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => {
                onOptionsChange(
                  options.filter((_, optionIndex) => optionIndex !== index)
                );
                onColorIndexesChange(
                  optionColorIndexes.filter(
                    (_, optionIndex) => optionIndex !== index
                  )
                );
              }}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        className="mt-3 flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
        onClick={() => {
          onOptionsChange([...options, ""]);
          onColorIndexesChange([
            ...optionColorIndexes,
            optionColorIndexes.length % TABLE_FIELD_OPTION_COLORS.length,
          ]);
        }}
        type="button"
      >
        <PlusIcon className="size-4" />
        Add an option
      </button>
    </section>
  );
}

export function ReferenceSourceSelector({
  formId,
  multiple,
  onChange,
  sources,
  value,
}: {
  formId: string;
  multiple: boolean;
  onChange: (value: string) => void;
  sources: readonly TableCustomFieldReferenceSource[];
  value: string;
}) {
  return (
    <section className="mt-8">
      <h3 className="font-medium text-sm">
        Source <span className="text-destructive">*</span>
      </h3>
      <p className="mt-1 text-muted-foreground text-sm">
        Choose the artifact type this field can reference
        {multiple ? " (multiple records of that type allowed)" : ""}.
      </p>
      <RadioGroup
        className="mt-5 grid gap-4 sm:grid-cols-2"
        onValueChange={onChange}
        value={value}
      >
        {sources.map(({ label, icon: Icon, value: sourceValue }, index) => {
          const sourceId = `${formId}-reference-source-${index}`;
          return (
            <label
              className="flex w-fit items-center gap-3 text-sm"
              htmlFor={sourceId}
              key={sourceValue}
            >
              <RadioGroupItem id={sourceId} value={sourceValue} />
              <span className="flex items-center gap-2 rounded-lg bg-muted/55 px-3 py-1.5">
                <Icon className="size-4 text-muted-foreground" />
                {label}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </section>
  );
}
