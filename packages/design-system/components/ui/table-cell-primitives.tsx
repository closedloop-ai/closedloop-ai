"use client";

import type { ElementType, ReactNode } from "react";
import { StarIcon } from "lucide-react";
import { Chip } from "./chip";
import { GridEmptyValue } from "./grid-table-card";
import {
  PersonAvatar,
  PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME,
} from "./person-avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import {
  TABLE_CELL_VALUE_STATE_METADATA,
  TableCellValueState,
} from "./table-cell-value-state";
import { useTableCellAlignEnd } from "@closedloop-ai/design-system/lib/table-cell-alignment";
import { cn } from "@closedloop-ai/design-system/lib/utils";

export {
  TABLE_CELL_UNAVAILABLE_LABEL,
  TableCellValueState,
} from "./table-cell-value-state";

const MAX_VISIBLE_PEOPLE = 4;

export type TablePerson = {
  avatarUrl?: string;
  initials?: string;
  name: string;
};

export function TableIdentityCell({
  disabled,
  errorLabel,
  focusVisible,
  icon: Icon,
  loadingLabel,
  selected,
  state,
  slug,
  title,
}: {
  icon: ElementType;
  slug: string;
  title: string;
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
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-2 font-medium text-sm",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      {...stateAttributes}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-normal text-muted-foreground">{slug}</span>
      <span className="truncate">{title}</span>
    </span>
  );
}

export function TableFavoriteCell({
  disabled,
  favorited,
  focusVisible,
  itemLabel,
  onFavoriteChange,
  selected,
}: {
  disabled?: boolean;
  favorited: boolean;
  focusVisible?: boolean;
  itemLabel: string;
  onFavoriteChange: (favorited: boolean) => void;
  selected?: boolean;
}) {
  const actionLabel = favorited
    ? `Remove ${itemLabel} from favorites`
    : `Add ${itemLabel} to favorites`;
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span className="flex size-full items-center justify-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={actionLabel}
            aria-pressed={favorited}
            className={cn(
              "flex size-full items-center justify-center rounded-sm text-muted-foreground/30 transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              TABLE_FAVORITE_FOCUS_FILL_CLASS,
              favorited && "text-amber-500",
              getTableCellPrimitiveStateClassName({
                disabled,
                focusVisible,
                selected,
              })
            )}
            disabled={disabled}
            onClick={() => {
              if (!disabled) {
                onFavoriteChange(!favorited);
              }
            }}
            type="button"
            {...stateAttributes}
          >
            <StarIcon
              className="size-4"
              fill={favorited ? "currentColor" : "none"}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {favorited ? "Remove from favorites" : "Add to favorites"}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

export function TablePersonCell({
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  person,
  selected,
  state,
}: {
  person?: TablePerson | null;
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
  if (!person) {
    return emptyCellValue({ disabled, focusVisible, selected });
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
      <PersonAvatar
        avatarUrl={person.avatarUrl}
        className="size-6"
        fallbackClassName={PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME}
        initials={person.initials}
        name={person.name}
      />
      <span className="truncate">{person.name}</span>
    </span>
  );
}

export function TablePeopleCell({
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  people,
  selected,
  state,
}: {
  people: readonly TablePerson[];
} & TableCellPrimitiveStateProps) {
  const uniquePeople = people.filter(
    (person, index) =>
      people.findIndex((item) => item.name === person.name) === index
  );
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
  if (uniquePeople.length === 0) {
    return emptyCellValue({ disabled, focusVisible, selected });
  }
  const visiblePeople = uniquePeople.slice(0, MAX_VISIBLE_PEOPLE);
  const hiddenPeople = uniquePeople.slice(MAX_VISIBLE_PEOPLE);
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        "flex items-center -space-x-1.5",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      {...stateAttributes}
    >
      <span className="sr-only">
        People: {uniquePeople.map((person) => person.name).join(", ")}
      </span>
      {visiblePeople.map((person) => (
        <Tooltip key={person.name}>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default">
              <PersonAvatar
                ariaLabel={person.name}
                avatarUrl={person.avatarUrl}
                className="size-7 border-2 border-background"
                fallbackClassName={PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME}
                initials={person.initials}
                name={person.name}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{person.name}</TooltipContent>
        </Tooltip>
      ))}
      {hiddenPeople.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-2 cursor-default text-muted-foreground text-xs">
              +{hiddenPeople.length}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {hiddenPeople.map((person) => person.name).join(", ")}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function TableChoiceCell({
  className,
  disabled,
  errorLabel,
  focusVisible,
  label,
  loadingLabel,
  selected,
  state,
}: {
  className?: string;
  label?: string | null;
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
  if (!label) {
    return emptyCellValue({ disabled, focusVisible, selected });
  }
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <Chip
      className={cn(
        "w-fit",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        }),
        className
      )}
      variant="outline"
      {...stateAttributes}
    >
      {label}
    </Chip>
  );
}

export function TableCountCell({
  ariaLabel,
  count,
  disabled,
  errorLabel,
  focusVisible,
  icon: Icon,
  loadingLabel,
  onClick,
  selected,
  state,
}: {
  ariaLabel?: string;
  count?: number | null;
  icon: ElementType;
  onClick?: () => void;
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
  if (count != null && !isValidTableCount(count)) {
    return invalidCellValue({ disabled, errorLabel, focusVisible, selected });
  }
  if (count == null) {
    return emptyCellValue({ disabled, focusVisible, selected });
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
      <Icon aria-hidden className="size-3.5" />
      <span className="tabular-nums">{count}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        aria-label={ariaLabel ?? `${count} items`}
        className={cn(
          "flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
          stateClassName
        )}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            onClick();
          }
        }}
        type="button"
        {...stateAttributes}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        "flex items-center gap-1.5 text-muted-foreground text-sm",
        stateClassName
      )}
      {...stateAttributes}
    >
      {content}
    </span>
  );
}

export function TableDateCell({
  disabled,
  errorLabel,
  focusVisible,
  fullValue,
  loadingLabel,
  selected,
  state,
  value,
}: {
  fullValue?: string;
  value?: string | null;
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
  if (!value) {
    return emptyCellValue({ disabled, focusVisible, selected });
  }
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        "truncate text-muted-foreground text-xs",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      title={fullValue}
      {...stateAttributes}
    >
      {value}
    </span>
  );
}

export function TableVersionCell({
  ariaLabel,
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  onClick,
  selected,
  state,
  value,
}: {
  ariaLabel?: string;
  onClick?: () => void;
  value?: string | null;
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
  if (!value) {
    return emptyCellValue({ disabled, focusVisible, selected });
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
  if (onClick) {
    return (
      <button
        aria-label={ariaLabel}
        className={cn(
          "font-mono text-sm hover:underline focus-visible:underline focus-visible:outline-none",
          stateClassName
        )}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            onClick();
          }
        }}
        type="button"
        {...stateAttributes}
      >
        {value}
      </button>
    );
  }
  return (
    <span
      className={cn("font-mono text-sm", stateClassName)}
      {...stateAttributes}
    >
      {value}
    </span>
  );
}

export function TableTextCell({
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  selected,
  state,
  value,
}: {
  value?: ReactNode;
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
  if (value == null || value === "") {
    return emptyCellValue({ disabled, focusVisible, selected });
  }
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        "min-w-0 truncate text-sm",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      {...stateAttributes}
    >
      {value}
    </span>
  );
}

export function TableNumberCell({
  alignEnd,
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  selected,
  state,
  value,
}: {
  /**
   * Which end of the cell the figure sits at. Omitted, the enclosing column's
   * declared alignment decides (ISS-9821), and outside a column that declares
   * one it stays `true` — digits read down a track only when they line up.
   */
  alignEnd?: boolean;
  value?: ReactNode;
} & TableCellPrimitiveStateProps) {
  const resolvedAlignEnd = useTableCellAlignEnd(alignEnd, true);
  const stateValue = getTableCellPrimitiveStateValue({
    alignEnd: resolvedAlignEnd,
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
  if (value == null || value === "") {
    return emptyCellValue({
      alignEnd: resolvedAlignEnd,
      disabled,
      focusVisible,
      selected,
    });
  }
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        "whitespace-nowrap text-sm tabular-nums",
        resolvedAlignEnd && "ml-auto",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      {...stateAttributes}
    >
      {value}
    </span>
  );
}

export function TableChangeCell({
  additions,
  alignEnd,
  deletions,
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  selected,
  state,
}: {
  additions?: number | null;
  /**
   * Where the states that do NOT fill the track sit — the em-dash, the loading
   * skeleton, the error label. The bars themselves are `w-full` and have no free
   * space to be moved through. Resolved exactly as {@link TableNumberCell}'s is,
   * so a change column and a number column beside it cannot answer the same
   * `column.align` differently (ISS-9821, visual-QA review) — pinned on the
   * em-dash, the readable one of those states, by the two adjacent-column cases
   * in `grid-table-v2-column-declarations.test.tsx`.
   */
  alignEnd?: boolean;
  deletions?: number | null;
} & TableCellPrimitiveStateProps) {
  const resolvedAlignEnd = useTableCellAlignEnd(alignEnd, true);
  const stateValue = getTableCellPrimitiveStateValue({
    alignEnd: resolvedAlignEnd,
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
  const additionsInvalid =
    additions != null && !isValidTableCount(additions);
  const deletionsInvalid =
    deletions != null && !isValidTableCount(deletions);
  const validAdditions = additionsInvalid ? null : (additions ?? null);
  const validDeletions = deletionsInvalid ? null : (deletions ?? null);
  if (validAdditions == null && validDeletions == null) {
    if (additionsInvalid || deletionsInvalid) {
      return invalidCellValue({
        alignEnd: resolvedAlignEnd,
        disabled,
        errorLabel: errorLabel ?? "Invalid change count",
        focusVisible,
        selected,
      });
    }
    return emptyCellValue({
      alignEnd: resolvedAlignEnd,
      disabled,
      focusVisible,
      selected,
    });
  }
  const total = (validAdditions ?? 0) + (validDeletions ?? 0);
  const additionsPercent =
    total > 0 ? ((validAdditions ?? 0) / total) * 100 : 0;
  const deletionsPercent =
    total > 0 ? ((validDeletions ?? 0) / total) * 100 : 0;
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      aria-label={`${formatTableChangeCountLabel({
        invalid: additionsInvalid,
        missingFallback: 0,
        noun: "additions",
        value: validAdditions,
      })}, ${formatTableChangeCountLabel({
        invalid: deletionsInvalid,
        missingFallback: 0,
        noun: "deletions",
        value: validDeletions,
      })}`}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 whitespace-nowrap",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      {...stateAttributes}
    >
      <span className="flex items-center gap-2 font-mono text-sm tabular-nums">
        {validAdditions == null ? null : (
          <span className="text-success">
            +{validAdditions.toLocaleString()}
          </span>
        )}
        {validDeletions == null ? null : (
          <span className="text-destructive">
            −{validDeletions.toLocaleString()}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className="flex h-1 w-full overflow-hidden rounded-full bg-muted/50"
      >
        <span
          className="bg-success"
          style={{ width: `${additionsPercent}%` }}
        />
        <span
          className="bg-destructive"
          style={{ width: `${deletionsPercent}%` }}
        />
      </span>
    </span>
  );
}

/**
 * ISS-8038: the favorite button fills its grid track, so its focus ring looked
 * identical before and after entry. A muted fill marks entry without shrinking
 * the target (WCAG 2.4.7). Exported for the state test.
 */
export const TABLE_FAVORITE_FOCUS_FILL_CLASS = "focus-visible:bg-muted";

export type TableCellPrimitiveStateProps = {
  disabled?: boolean;
  errorLabel?: string;
  focusVisible?: boolean;
  loadingLabel?: string;
  selected?: boolean;
  state?: TableCellValueState;
};

export function getTableCellPrimitiveStateAttributes({
  disabled,
  focusVisible,
  selected,
}: Pick<
  TableCellPrimitiveStateProps,
  "disabled" | "focusVisible" | "selected"
>): TableCellPrimitiveStateAttributes {
  return {
    "aria-disabled": disabled ? true : undefined,
    "data-cell-disabled": disabled ? true : undefined,
    "data-cell-focus-visible": focusVisible ? true : undefined,
    "data-cell-selected": selected ? true : undefined,
  };
}

export function getTableCellPrimitiveStateClassName({
  disabled,
  focusVisible,
  selected,
}: Pick<
  TableCellPrimitiveStateProps,
  "disabled" | "focusVisible" | "selected"
>) {
  return cn(
    (disabled || focusVisible || selected) && "rounded-sm",
    disabled && "pointer-events-none opacity-50",
    focusVisible && "ring-2 ring-ring ring-inset",
    selected && "bg-primary/10 text-foreground"
  );
}

export function getTableCellPrimitiveStateValue({
  alignEnd,
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  selected,
  state = TableCellValueState.Default,
}: TableCellPrimitiveStateValueOptions): ReactNode | null {
  if (state === TableCellValueState.Default) {
    return null;
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

  if (state === TableCellValueState.Loading) {
    const accessibleLabel = loadingLabel ?? "Loading cell value";
    return (
      <span
        aria-busy="true"
        className={cn(
          "inline-flex h-5 min-w-16 items-center",
          alignEnd && "ml-auto justify-end",
          stateClassName
        )}
        data-cell-value-state={state}
        role="status"
        {...stateAttributes}
      >
        <span className="sr-only">{accessibleLabel}</span>
        <span
          aria-hidden
          className="h-2 w-16 animate-pulse rounded-full bg-muted-foreground/30"
        />
      </span>
    );
  }

  const metadata = TABLE_CELL_VALUE_STATE_METADATA[state];
  const Icon = metadata.icon;
  return (
    <span
      aria-label={
        state === TableCellValueState.Error
          ? (errorLabel ?? metadata.accessibleLabel)
          : metadata.accessibleLabel
      }
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-sm",
        metadata.className,
        alignEnd && "ml-auto",
        stateClassName
      )}
      data-cell-value-state={state}
      role={state === TableCellValueState.Error ? "status" : undefined}
      {...stateAttributes}
    >
      {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
      <span>{metadata.visibleLabel}</span>
    </span>
  );
}

type TableCellPrimitiveStateAttributes = {
  "aria-disabled"?: true;
  "data-cell-disabled"?: true;
  "data-cell-focus-visible"?: true;
  "data-cell-selected"?: true;
};

type TableCellPrimitiveStateValueOptions = TableCellPrimitiveStateProps & {
  alignEnd?: boolean;
};

function emptyCellValue({
  alignEnd,
  disabled,
  focusVisible,
  selected,
}: TableCellPrimitiveStateProps & { alignEnd?: boolean }) {
  return (
    <GridEmptyValue
      alignEnd={alignEnd}
      disabled={disabled}
      focusVisible={focusVisible}
      selected={selected}
    />
  );
}

function invalidCellValue({
  alignEnd,
  disabled,
  errorLabel = "Invalid count",
  focusVisible,
  selected,
}: TableCellPrimitiveStateProps & { alignEnd?: boolean }) {
  return getTableCellPrimitiveStateValue({
    alignEnd,
    disabled,
    errorLabel,
    focusVisible,
    selected,
    state: TableCellValueState.Error,
  });
}

function isValidTableCount(value: number | null | undefined): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function formatTableChangeCountLabel({
  invalid,
  missingFallback,
  noun,
  value,
}: {
  invalid: boolean;
  missingFallback: number;
  noun: "additions" | "deletions";
  value: number | null;
}) {
  if (invalid) {
    return `${noun} unavailable`;
  }

  return `${value ?? missingFallback} ${noun}`;
}
