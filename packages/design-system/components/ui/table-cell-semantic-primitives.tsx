"use client";

import { Chip } from "./chip";
import { GridEmptyValue } from "./grid-table-card";
import { PriorityIcon } from "./priority-icon";
import {
  getTableCellPrimitiveStateAttributes,
  getTableCellPrimitiveStateClassName,
  getTableCellPrimitiveStateValue,
  type TableCellPrimitiveStateProps,
  type TableCellValueState,
} from "./table-cell-primitives";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import {
  type PriorityValue,
  priorityLabel,
} from "@closedloop-ai/design-system/lib/priority-order";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { FolderGit2Icon } from "lucide-react";

/**
 * Named accessors, spelled alphabetically — so this object's iteration order is
 * NOT semantic order. Read `PRIORITY_VALUES_HIGHEST_FIRST` for that.
 */
export const TablePriority = {
  High: "HIGH",
  Low: "LOW",
  Medium: "MEDIUM",
  Urgent: "URGENT",
} as const satisfies Readonly<Record<string, PriorityValue>>;
export type TablePriority = PriorityValue;

export function TablePriorityCell({
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  priority,
  selected,
  state,
}: {
  priority?: TablePriority | null;
} & TableCellPrimitiveStateProps) {
  const stateValue = getTableCellPrimitiveStateValue({
    disabled,
    errorLabel,
    focusVisible,
    loadingLabel,
    selected,
    state,
  });
  if (stateValue) {
    return stateValue;
  }
  if (!priority) {
    return (
      <GridEmptyValue
        disabled={disabled}
        focusVisible={focusVisible}
        selected={selected}
      />
    );
  }
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-2 text-sm",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      {...stateAttributes}
    >
      <PriorityIcon aria-hidden priority={priority} />
      <span className="truncate text-muted-foreground">
        {priorityLabel(priority)}
      </span>
    </span>
  );
}

export function TableModelCell({
  disabled,
  errorLabel,
  focusVisible,
  indicatorClassName,
  loadingLabel,
  model,
  providerLabel,
  selected,
  state,
}: {
  disabled?: boolean;
  errorLabel?: string;
  focusVisible?: boolean;
  indicatorClassName?: string;
  loadingLabel?: string;
  model?: string | null;
  providerLabel?: string;
  selected?: boolean;
  state?: TableCellValueState;
}) {
  const stateValue = getTableCellPrimitiveStateValue({
    disabled,
    errorLabel,
    focusVisible,
    loadingLabel,
    selected,
    state,
  });
  if (stateValue) {
    return stateValue;
  }
  if (!model) {
    return (
      <GridEmptyValue
        disabled={disabled}
        focusVisible={focusVisible}
        selected={selected}
      />
    );
  }
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          indicatorClassName ?? "text-muted-foreground"
        )}
      />
      <span className="truncate">{model}</span>
    </>
  );
  const chip = (
    <Chip
      className={cn(
        "min-w-0 gap-1.5",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      interactive={!disabled}
      tabIndex={disabled ? undefined : 0}
      variant="outline"
      {...stateAttributes}
    >
      {content}
    </Chip>
  );
  if (disabled) {
    return chip;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">
        {providerLabel ? `${providerLabel} · ${model}` : model}
      </TooltipContent>
    </Tooltip>
  );
}

export function TableRepositoryCell({
  disabled,
  errorLabel,
  focusVisible,
  fullName,
  label,
  loadingLabel,
  onSelect,
  selected,
  state,
}: {
  disabled?: boolean;
  errorLabel?: string;
  focusVisible?: boolean;
  fullName?: string;
  label?: string | null;
  loadingLabel?: string;
  onSelect?: () => void;
  selected?: boolean;
  state?: TableCellValueState;
}) {
  const stateValue = getTableCellPrimitiveStateValue({
    disabled,
    errorLabel,
    focusVisible,
    loadingLabel,
    selected,
    state,
  });
  if (stateValue) {
    return stateValue;
  }
  if (!label) {
    return (
      <GridEmptyValue
        disabled={disabled}
        focusVisible={focusVisible}
        selected={selected}
      />
    );
  }
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  const stateClassName = getTableCellPrimitiveStateClassName({
    disabled,
    focusVisible,
    selected,
  });
  const content = (
    <>
      <FolderGit2Icon aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );
  if (!onSelect) {
    return (
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm",
          stateClassName
        )}
        title={fullName}
        {...stateAttributes}
      >
        {content}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`Open ${fullName ?? label} repository`}
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none",
            stateClassName
          )}
          disabled={disabled}
          onClick={() => {
            if (!disabled) {
              onSelect();
            }
          }}
          type="button"
          {...stateAttributes}
        >
          {content}
        </button>
      </TooltipTrigger>
      <TooltipContent>{fullName ?? label}</TooltipContent>
    </Tooltip>
  );
}
