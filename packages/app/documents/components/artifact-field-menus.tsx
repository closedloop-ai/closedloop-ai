"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  ArtifactStatus,
  DocumentStatus,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  DOCUMENT_STATUS_OPTIONS,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { IssueStatusIcon } from "@repo/app/documents/components/issue-status-icon";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { usePriorityOptions } from "@repo/app/shared/hooks/use-priority-options";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import type { ReactElement } from "react";

/**
 * The status and priority menus every artifact surface opens — the documents
 * grid's cells and the artifact rows on document detail pages.
 *
 * Only the MENU is shared, never the trigger: a grid cell, a 7x7 glyph button
 * and a compact detail row want different geometry, and forcing one box on all
 * of them is how a shared component grows a `variant` prop per caller. What
 * must not diverge is what the menu OFFERS — the vocabulary, the per-option
 * icon, and the label — because a second copy of that is how one surface
 * quietly stops listing a status the other lists. `trigger` is handed to
 * `DropdownMenuTrigger asChild`, the same seam `DatePickerPopover` and
 * `UserSelectPopover` already use.
 */
export function ArtifactStatusMenu({
  isFeature,
  onSelect,
  tooltipLabel,
  trigger,
}: Readonly<{
  /**
   * Documents and Features carry disjoint status vocabularies (PRD-495), so the
   * caller states which one this artifact speaks. Features expose the full set
   * including TRIAGE — a human may move a row to any status; TRIAGE is only
   * excluded as the human-create default.
   */
  isFeature: boolean;
  onSelect: (status: ArtifactStatus) => void;
  /**
   * Hover label for the trigger. Applied HERE rather than by the caller because
   * the tooltip has to sit OUTSIDE `DropdownMenuTrigger asChild` — a caller
   * handing in a tooltip-wrapped trigger would have `asChild` clone a Radix
   * Root instead of a DOM node, and the trigger would silently stop opening.
   */
  tooltipLabel?: string;
  /** The trigger element itself, cloned by `DropdownMenuTrigger asChild`. */
  trigger: ReactElement;
}>) {
  const options = isFeature ? ISSUE_STATUS_OPTIONS : DOCUMENT_STATUS_OPTIONS;
  return (
    <DropdownMenu>
      <ArtifactStatusTooltip label={tooltipLabel}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      </ArtifactStatusTooltip>
      <DropdownMenuContent align="start">
        {options.map((value) => (
          <DropdownMenuItem
            key={value}
            onClick={() => {
              onSelect(value);
            }}
          >
            <ArtifactStatusIconFor
              // The label beside it already names this option. The status
              // glyphs carry their own `aria-label`, so leaving it on would
              // make the item announce "In Progress In Progress".
              decorative
              isFeature={isFeature}
              status={value}
            />
            {ARTIFACT_STATUS_LABELS[value]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * ISS-9665: with {@link ARTIFACT_PRIORITY_UNSET_FLAG_KEY} on, the menu offers a
 * "No priority" item that CLEARS the field. It is the only way to reach the
 * state the API can now represent — every other item sets one of the four
 * members, so an artifact that acquired a priority could never lose it again.
 * The item carries the design system's empty-value mark and the same word the
 * priority group header already uses; the state is never signalled by the
 * absence of a colour alone (WCAG 1.4.1).
 */
export function ArtifactPriorityMenu({
  allowUnset = false,
  onOpenChange,
  onSelect,
  trigger,
}: Readonly<{
  /**
   * Whether THIS row's entity can hold "no priority". Artifacts and Projects
   * both can, on one contract since ISS-9441; a Branch or Session carries no
   * priority column at all, so the item would offer to clear a field that does
   * not exist. A domain capability, not the feature gate: the flag decides
   * whether the affordance exists AT ALL, this decides whether this particular
   * row is one it may be offered on. Callers read it from
   * `ARTIFACT_PRIORITY_SUPPORT` rather than deciding it themselves.
   */
  allowUnset?: boolean;
  /**
   * ISS-9307: lets the champion editor quiet its mark while the menu is the
   * thing being read. Optional, so the callers that never needed it are
   * unchanged.
   */
  onOpenChange?: (open: boolean) => void;
  onSelect: (priority: Priority | null) => void;
  trigger: ReactElement;
}>) {
  const unsetEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const options = usePriorityOptions();
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((value) => (
          <DropdownMenuItem
            key={value}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(value);
            }}
          >
            <PriorityIcon priority={value} />
            {PRIORITY_LABELS[value]}
          </DropdownMenuItem>
        ))}
        {allowUnset && unsetEnabled && (
          <DropdownMenuItem
            onClick={(event) => {
              event.stopPropagation();
              onSelect(null);
            }}
          >
            {/* Decorative: the label beside it is what states the value, so
                leaving the dash in the accessibility tree would make the item
                announce as "— No priority". Same rule as the status glyphs
                above. */}
            <span aria-hidden="true">
              <GridEmptyValue />
            </span>
            {NO_PRIORITY_LABEL}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Shared hover tooltip for every status glyph on an artifact surface: the
 * table's read-only rows and editable dropdown triggers, the branch/session
 * rows, and the artifact rows on document detail pages. Renders children
 * unwrapped when no label is available.
 */
export function ArtifactStatusTooltip({
  children,
  label,
}: Readonly<{ children: ReactElement; label?: string }>) {
  if (!label) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The status icon in one artifact's own vocabulary (PRD-495).
 *
 * `decorative` removes it from the accessibility tree. Pass it ONLY where a
 * sibling or ancestor already states the same status — a menu item beside its
 * own label, or a button carrying an `aria-label`. Everywhere else the glyph's
 * own name is the only thing naming the status, so hiding it would delete the
 * fact rather than deduplicate it.
 */
export function ArtifactStatusIconFor({
  decorative,
  isFeature,
  size = 16,
  status,
}: Readonly<{
  decorative?: boolean;
  isFeature: boolean;
  size?: 16 | 20;
  status: ArtifactStatus;
}>) {
  return isFeature ? (
    <IssueStatusIcon
      aria-hidden={decorative}
      size={size}
      status={status as IssueStatus}
    />
  ) : (
    <DocumentStatusIcon
      aria-hidden={decorative}
      size={size}
      status={status as DocumentStatus}
    />
  );
}

/**
 * The priority trigger's accessible name. A trigger that renders only the
 * colored glyph names nothing at all, and an unset one names nothing plus says
 * nothing about what activating it does (WCAG 2.4.6). Shared so the grid cell
 * and the detail row cannot announce the same control two ways.
 *
 * Takes the raw stored value, not a narrowed `Priority`, because this is the
 * render boundary for a wire value: a member only a newer peer knows reaches
 * here at runtime, and `PRIORITY_LABELS[…]` would have named that control
 * "Priority: undefined". `priorityLabel` answers "Unknown priority" for it and
 * "No priority" for a null, which is the same separation the mark makes.
 */
export function priorityTriggerLabel(priority: string | null): string {
  return priority
    ? `${PRIORITY_TRIGGER_FIELD_LABEL}: ${priorityLabel(priority)}`
    : "Set priority";
}

/** The field word a set priority trigger names before its value. */
export const PRIORITY_TRIGGER_FIELD_LABEL = "Priority";
