"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  actionForState,
  type CellAction,
  CellState,
  HARNESS_LABEL,
  type Harness,
  type Target,
} from "../mock";
import { CELL_STATUS } from "./cell-status";

// Per-cell interaction affordance. The status glyph + label carry the state (say
// it once); the button underneath is the single action that state affords. A
// terminal or blocked state (offline / unsupported / converting) shows the
// status only, no action to offer. Everything reads without color: shape +
// label do the work.
type MatrixCellProps = {
  target: Target;
  harness: Harness;
  state: CellState;
  onAction: (targetId: string, harness: Harness, action: CellAction) => void;
};

// Visible button label per affordable action. The action itself (the intent) is
// what gets handed to onAction; this map is only the short glyph-adjacent text.
const ACTION_LABEL: Record<CellAction, string> = {
  install: "Install",
  update: "Update",
  remove: "Remove",
  retry: "Retry",
};

// The full accessible name for a cell's action, e.g.
// "Install pre-commit-guard on parkers-mbp for Codex". The visible button label
// is short; the surrounding target + harness live in aria so a screen reader
// user hears the whole coordinate without reading the row and column separately.
const actionAriaLabel = (
  label: string,
  target: Target,
  harness: Harness
): string => `${label} on ${target.name} for ${HARNESS_LABEL[harness]}`;

export const MatrixCell = ({
  target,
  harness,
  state,
  onAction,
}: MatrixCellProps) => {
  const status = CELL_STATUS[state];
  const action = actionForState(state);
  const StatusGlyph = status.render(16);

  const statusText = (
    <span
      className={`flex items-center gap-1.5 text-sm ${
        status.emphatic ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      {StatusGlyph}
      {status.label}
    </span>
  );

  // Offline: state is unknown, so we say why rather than showing a dead action.
  if (state === CellState.OfflineUnknown) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5">{statusText}</span>
        </TooltipTrigger>
        <TooltipContent>
          {target.name} is offline. Install state will sync when it reconnects.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (state === CellState.Unsupported) {
    return statusText;
  }

  if (!action) {
    // Converting: transient, no action to offer.
    return statusText;
  }

  const label = ACTION_LABEL[action];
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      {statusText}
      <Button
        aria-label={actionAriaLabel(label, target, harness)}
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => onAction(target.id, harness, action)}
        size="sm"
        variant={state === CellState.NotInstalled ? "outline" : "ghost"}
      >
        {label}
      </Button>
    </div>
  );
};
