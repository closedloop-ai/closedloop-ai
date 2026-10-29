"use client";

/**
 * The Branches toolbar CONTRACT and its facet-group builders — the props shape,
 * the nine facet groups, and the reset label that `BranchesListToolbarV2` reads.
 *
 * ISS-10301 retired the v1 `BranchesToolbar` component that used to live here
 * alongside them; this module is what survived it, so the one live toolbar and
 * every host that composes it keep reading a single contract instead of a copy.
 */

import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import type { BranchListFacets } from "@repo/api/src/types/branch-list-contract";
import type { PriorityFilterValue } from "@repo/api/src/types/priority-filter";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
// Cross-slice: the documents slice owns the key that gates every "No priority"
// affordance, and the Branches facet's option is one more of them (ISS-10332).
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { usePriorityOptions } from "@repo/app/shared/hooks/use-priority-options";
import { artifactStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { type ReactNode, useMemo } from "react";
import type { TimezoneMode } from "../../shared/lib/date-window-timezone-mode";
import type { DateRange } from "../../shared/lib/format-utils";
import type { BranchColumnId } from "../hooks/use-branch-view-state";
import {
  branchFilterFacetGroups,
  branchServerFacetGroups,
  legacyBranchFilterFacetGroups,
} from "../lib/branch-filter-adapter";
import {
  BranchFilterFacet,
  type BranchFilters,
  type BranchRow,
} from "../lib/branch-row";

export type BranchesToolbarProps = {
  filters: BranchFilters;
  onFiltersChange: (next: BranchFilters) => void;
  rows: BranchRow[];
  /** First-class time window — drives the list query AND the summary metrics. */
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  /**
   * ISS-9619 — which day boundary the window means, and the writer for it. Both
   * or neither: the control renders only when the host supplies the setter, so a
   * host without it renders exactly the toolbar it renders today.
   */
  timezoneMode?: TimezoneMode;
  onTimezoneModeChange?: (mode: TimezoneMode) => void;
  visibleColumns: Set<string>;
  onToggleColumn: (id: BranchColumnId) => void;
  /**
   * "Reset view" (FEA-4021; ISS-12664): back to how the surface ships — columns,
   * order and widths, summary cards, grouping and collapsed bands. The host owns
   * it because grouping is URL-stated; compose it with `composeBranchResetView`.
   */
  onResetView?: () => void;
  /** Extra actions render after the built-in controls. */
  trailing?: ReactNode;
  /** Complete PRD-601 controls, selected by the default-off host flag. */
  approved?: boolean;
  /**
   * ISS-12664: the summary cards the reader hid, and the writer that flips one.
   * Both or neither: the Options menu grows its card rows only when the host
   * supplies both, so a host without them renders the menu it renders today.
   */
  hiddenSummaryCards?: ReadonlySet<string>;
  onToggleSummaryCard?: (cardId: string) => void;
  /** Captured producer clock shared by row filtering and self-excluding facets. */
  now?: number;
  /** Producer-owned exact pre-pagination counts in bounded List mode. */
  facets?: BranchListFacets;
};

/**
 * ISS-10332 (#7762 review): the host's opt-in to the Priority column and its
 * Columns-picker, Sort and Filter entries. Closed by default: only a host whose
 * source serves `priority` passes `true`.
 */
export type BranchesPriorityColumnOptIn = {
  includePriorityColumn?: boolean;
};

/**
 * ISS-12456: the host's opt-in to the Tags column's Columns-picker entry.
 * Closed by default: only a host whose source serves `tags` passes `true`.
 */
export type BranchesTagsColumnOptIn = {
  includeTagsColumn?: boolean;
};

/**
 * ISS-12456: the host's opt-in to the Project column's Columns-picker entry.
 * Closed by default: only a host whose source serves `project` passes `true`.
 * Project has no sort key or filter facet (`branch-column-view-model.ts`), so
 * there is no facet to also gate here, unlike Priority and Tags.
 */
export type BranchesProjectColumnOptIn = {
  includeProjectColumn?: boolean;
};

/**
 * The facet groups the Branches toolbar offers.
 *
 * Lives here rather than inside `BranchesListToolbarV2` (ISS-9225) so the facet
 * selection has one owner: a second copy is how a branch list comes to disagree
 * with itself about which filters it has.
 */
export function resolveBranchToolbarFacetGroups({
  approved,
  facets,
  filters,
  now,
  onFiltersChange,
  priorityFacetValues,
  rows,
}: Pick<
  BranchesToolbarProps,
  "approved" | "facets" | "filters" | "now" | "onFiltersChange" | "rows"
> & {
  /** @see useBranchToolbarFacetGroups — the resolved priority option list. */
  priorityFacetValues: readonly PriorityFilterValue[];
}) {
  if (approved && facets) {
    return branchServerFacetGroups(
      facets,
      filters,
      onFiltersChange,
      priorityFacetValues
    );
  }
  if (approved) {
    return branchFilterFacetGroups(
      rows,
      filters,
      onFiltersChange,
      priorityFacetValues,
      now
    );
  }
  return legacyBranchFilterFacetGroups(rows, filters, onFiltersChange);
}

/** Selects complete legacy or universal status options for both Branch toolbars. */
export function useBranchToolbarFacetGroups({
  includePriorityColumn = false,
  includeTagsColumn = false,
  ...props
}: Pick<
  BranchesToolbarProps,
  "approved" | "facets" | "filters" | "now" | "onFiltersChange" | "rows"
> &
  BranchesPriorityColumnOptIn &
  BranchesTagsColumnOptIn) {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  // ISS-10332: the priority facet's options, resolved HERE because both halves
  // are flag reads. The ORDER is the one every priority menu offers, so the
  // facet and the cell's editor one click away cannot list the vocabulary in
  // opposite directions; the "No priority" option rides the same key that
  // gates the editor's clear item and the Documents facet's matching option,
  // so a reader is never offered a filter for a state no control can set.
  const priorityOrder = usePriorityOptions();
  const unsetEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const priorityFacetValues = useMemo<readonly PriorityFilterValue[]>(
    () =>
      unsetEnabled ? [...priorityOrder, PRIORITY_UNSET_VALUE] : priorityOrder,
    [priorityOrder, unsetEnabled]
  );
  const resolvedGroups = resolveBranchToolbarFacetGroups({
    ...props,
    priorityFacetValues,
  });
  // A priority selection on a source that serves none would match no row.
  const groupsWithPriorityOptIn = includePriorityColumn
    ? resolvedGroups
    : resolvedGroups.filter((group) => group.id !== BranchFilterFacet.Priority);
  // ISS-12456: same reasoning for Tags — a source whose rows never carry a
  // tag (the desktop local store) would offer a filter that matches nothing.
  const groups = includeTagsColumn
    ? groupsWithPriorityOptIn
    : groupsWithPriorityOptIn.filter(
        (group) => group.id !== BranchFilterFacet.Tags
      );
  if (!champion) {
    return groups;
  }

  return groups.map((group) => {
    if (group.kind === "range" || group.id !== BranchFilterFacet.Status) {
      return group;
    }
    return {
      ...group,
      options: group.options.map((option) => {
        const facet = artifactStatusFacet(
          ArtifactStatusVocabulary.Branch,
          option.id
        );
        const label = artifactStatusLabel(facet);
        return {
          ...option,
          content: (
            <UniversalArtifactStatus
              facet={facet}
              variant={ArtifactStatusVariant.FilterOption}
            />
          ),
          label,
          searchText: label,
        };
      }),
    };
  });
}
