"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { TABLE_BULK_ACTION_BUTTON_CLASS_NAME } from "@repo/design-system/components/ui/table-bulk-action-bar";
import type { TableBulkActionOption } from "@repo/design-system/components/ui/table-bulk-actions";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { Loader2Icon, TagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { LIST_SUMMARY_LOADING_DETAIL } from "../../shared/lib/list-summary-loading-detail";
import {
  BULK_TAG_ACTION_LABEL,
  BULK_TAG_EMPTY_LABEL,
} from "../lib/bulk-tag-labels";

/** Shared picker chrome; callers retain identity mapping, permissions and mutations. */
export function BulkTagPicker({
  actionLabel = BULK_TAG_ACTION_LABEL,
  errorMessage,
  catalogError,
  emptyLabel = BULK_TAG_EMPTY_LABEL,
  icon = <TagIcon />,
  isLoading = false,
  isPending,
  onOpenChange,
  onSelect,
  open,
  options,
  presentation = "button",
}: {
  /** Accessible action name and visible button copy for the host operation. */
  actionLabel?: string;
  errorMessage?: string;
  catalogError?: string;
  /** Empty-catalog copy supplied by the operation owner. */
  emptyLabel?: string;
  /** Operation icon; decorative because the action label names the control. */
  icon?: ReactNode;
  isLoading?: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (option: TableBulkActionOption) => Promise<boolean>;
  open: boolean;
  options: readonly TableBulkActionOption[];
  presentation?: "button" | "rail";
}) {
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      {presentation === "rail" ? (
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                aria-label={actionLabel}
                className={TABLE_BULK_ACTION_BUTTON_CLASS_NAME}
                disabled={isPending}
                type="button"
              >
                {icon}
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent>{actionLabel}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>
          <Button
            className="h-8 text-xs"
            disabled={isPending}
            size="sm"
            variant="outline"
          >
            {icon}
            {actionLabel}
          </Button>
        </PopoverTrigger>
      )}
      <PopoverContent
        align="center"
        className="w-56 p-2"
        onInteractOutside={(event) => {
          if (errorMessage) {
            // Keep failed-row retry reachable while the reader narrows selection.
            event.preventDefault();
          }
        }}
      >
        {errorMessage ? (
          <p className="px-2 py-1.5 text-destructive text-sm" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <BulkTagCatalog
          catalogError={catalogError}
          emptyLabel={emptyLabel}
          isLoading={isLoading}
          isPending={isPending}
          onSelect={onSelect}
          options={options}
        />
      </PopoverContent>
    </Popover>
  );
}

function BulkTagCatalog({
  catalogError,
  emptyLabel,
  isLoading,
  ...options
}: {
  catalogError?: string;
  emptyLabel: string;
  isLoading: boolean;
  isPending: boolean;
  onSelect: (option: TableBulkActionOption) => Promise<boolean>;
  options: readonly TableBulkActionOption[];
}) {
  if (catalogError) {
    return (
      <p className="px-2 py-1.5 text-destructive text-sm" role="alert">
        {catalogError}
      </p>
    );
  }
  if (isLoading) {
    // The accessible loading status `TableCellValue` uses: a polite, busy
    // status named by the shared loading caption, the spinner itself hidden.
    return (
      <div
        aria-busy="true"
        className="flex items-center justify-center py-4"
        role="status"
      >
        <span className="sr-only">{LIST_SUMMARY_LOADING_DETAIL}</span>
        <Loader2Icon
          aria-hidden
          className="h-4 w-4 animate-spin text-muted-foreground"
        />
      </div>
    );
  }
  return <BulkTagOptions emptyLabel={emptyLabel} {...options} />;
}

function BulkTagOptions({
  emptyLabel,
  isPending,
  onSelect,
  options,
}: {
  emptyLabel: string;
  isPending: boolean;
  onSelect: (option: TableBulkActionOption) => Promise<boolean>;
  options: readonly TableBulkActionOption[];
}) {
  if (options.length === 0) {
    return (
      <p className="py-2 text-center text-muted-foreground text-sm">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
      {options.map((option) => (
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          disabled={isPending}
          key={option.id}
          onClick={() => onSelect(option)}
          type="button"
        >
          {option.content ?? option.label}
        </button>
      ))}
    </div>
  );
}
