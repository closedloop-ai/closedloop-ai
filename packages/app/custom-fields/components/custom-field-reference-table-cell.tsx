"use client";

import type {
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { toggleListValue } from "@repo/app/shared/lib/toggle-list-value";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { TableReferenceListCell } from "@repo/design-system/components/ui/table-cell-list-primitives";
import { CheckIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import {
  ReferenceSearchMoreHint,
  ReferenceSearchStatus,
  useCustomFieldReferenceSearch,
} from "./custom-field-reference-search";
import type { CustomFieldTableValue } from "./custom-field-table-cell";

export function EditableReferenceCustomFieldCell({
  field,
  itemLabel,
  loadOptions,
  onValueChange,
  options = [],
  ownerEntityId,
  value,
}: {
  field: CustomFieldWithOptions;
  itemLabel: string;
  loadOptions?: (query: string) => Promise<CustomFieldReferenceSearchResponse>;
  onValueChange: (value: CustomFieldTableValue) => unknown;
  options?: readonly CustomFieldReferenceTarget[];
  /** The entity that owns this value; never offered as one of its own targets. */
  ownerEntityId: string;
  value?: CustomFieldValueDetail;
}) {
  const [open, setOpen] = useState(false);
  const clearEnabled = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY
  );
  const search = useCustomFieldReferenceSearch({
    field,
    loadOptions,
    open,
    options,
    ownerEntityId,
    value,
  });
  const selectedIds = value?.referenceValues.map((target) => target.id) ?? [];
  const multiple = field.fieldType === CustomFieldType.ReferenceMulti;

  const choose = (targetId: string) => {
    if (multiple) {
      consumeReferenceWrite(
        onValueChange(toggleListValue(selectedIds, targetId))
      );
      return;
    }
    consumeReferenceWrite(onValueChange(targetId));
    setOpen(false);
  };
  // Single-select only: choosing commits and closes, so without this the first
  // target picked is permanent. REFERENCE_MULTI needs no equivalent — every
  // target already toggles off by choosing it again.
  const canClear = clearEnabled && !multiple && selectedIds.length > 0;
  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          search.reset();
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit ${field.name} for ${itemLabel}`}
          className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-muted"
          data-grid-primary-editor=""
          type="button"
        >
          <TableReferenceListCell
            references={(value?.referenceValues ?? []).map((target) => ({
              id: target.id,
              label: target.slug ?? target.name,
              tooltip: target.name,
            }))}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0">
        <div className="border-b p-2">
          <div className="flex items-center gap-2 rounded-md border bg-background px-2">
            <LinkIcon aria-hidden className="size-4 text-muted-foreground" />
            <input
              aria-label={`Search ${field.name} references`}
              autoFocus
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => search.setQuery(event.target.value)}
              placeholder="Search references…"
              value={search.query}
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          <ReferenceSearchResults
            error={search.loadError}
            hasMore={search.hasMore}
            isLoading={search.isSearching}
            multiple={multiple}
            onChoose={choose}
            onRetry={search.retry}
            options={search.matchingOptions}
            query={search.query}
            selectedIds={selectedIds}
          />
        </div>
        {multiple && selectedIds.length > 0 ? (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {selectedIds.length} selected
            </span>
            <button
              className="rounded-md px-2 py-1 font-medium text-sm hover:bg-muted"
              onClick={() => setOpen(false)}
              type="button"
            >
              Done
            </button>
          </div>
        ) : null}
        {canClear ? (
          <div className="border-t p-2">
            <Button
              className="w-full text-muted-foreground"
              onClick={() => {
                consumeReferenceWrite(onValueChange(null));
                setOpen(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear {field.name}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ReferenceSearchResults({
  error,
  hasMore,
  isLoading,
  multiple,
  onChoose,
  onRetry,
  options,
  query,
  selectedIds,
}: {
  error: boolean;
  hasMore: boolean;
  isLoading: boolean;
  multiple: boolean;
  onChoose: (targetId: string) => void;
  onRetry: () => void;
  options: readonly CustomFieldReferenceTarget[];
  query: string;
  selectedIds: readonly string[];
}) {
  const status = (
    <ReferenceSearchStatus
      error={error}
      isLoading={isLoading}
      onRetry={onRetry}
      optionCount={options.length}
      query={query}
    />
  );
  if (error || isLoading || options.length === 0) {
    return status;
  }
  return (
    <>
      {options.map((target) => (
        <button
          aria-pressed={multiple ? selectedIds.includes(target.id) : undefined}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
          key={target.id}
          onClick={() => onChoose(target.id)}
          type="button"
        >
          <span className="shrink-0 font-mono text-muted-foreground text-xs">
            {target.slug ?? target.id}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{target.name}</span>
          {selectedIds.includes(target.id) ? (
            <CheckIcon aria-hidden className="size-4" />
          ) : null}
        </button>
      ))}
      <ReferenceSearchMoreHint hasMore={hasMore} />
    </>
  );
}

/**
 * Consumes a write this editor does not await. It has no rollback, so a
 * rejection has nothing to tell it — but the Sessions host now RETURNS its
 * mutation promise (ISS-9352) instead of swallowing it, so an unconsumed one
 * would surface as an unhandled rejection. The shared QueryClient already owns
 * the user-facing error, so this adds no second toast.
 */
function consumeReferenceWrite(result: unknown): void {
  Promise.resolve(result).catch(() => undefined);
}
