"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { TagEntityType, TagSummary } from "@repo/api/src/types/tag";
import { TagChips } from "@repo/app/shared/components/tag-chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import type { QueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { TagPicker } from "./tag-picker";

/**
 * ISS-9215: the ONE tags cell every table renders — Sessions, Branches and
 * Documents. Three call sites had grown three contracts against the same
 * `TagPicker`, and only one of them (Branches) capped the inline chips or fell
 * back to plain chips when the reader could not act; the other two asked the
 * picker for its own applied-chip rendering and got an uncapped, uncoordinated
 * row of them. Any future change to chip truncation, overflow, or the trigger's
 * affordances now lands on all three at once instead of two of three.
 *
 * A genuine per-surface difference is a PROP here with its reason stated at the
 * call site — `emptyValue` and `onChipClick` are the two that survived the
 * merge. Everything else was drift.
 *
 * What this component does NOT decide is AVAILABILITY: whether the producer
 * loaded the relation at all is each surface's own vocabulary (Sessions'
 * `ArtifactTagAvailability`, Branches' `BranchTagAvailability`, Documents'
 * feature gate), so each adapter answers that before delegating here.
 */
type EntityTagsCellProps = {
  /** Permit applying existing or newly created tags. */
  canApply: boolean;
  /** Permit removing applied tags. */
  canRemove: boolean;
  /**
   * Accessible name for the editor trigger. A table of rows renders a column of
   * otherwise identical buttons, so this must name WHICH row it opens.
   */
  editLabel: string;
  /** Rendered when the entity has no tags and no editor is offered. */
  emptyValue?: ReactNode;
  /** The taggable entity, or `null` when this row has none to write against. */
  entityId: string | null;
  entityType: TagEntityType;
  /**
   * Chips rendered before the overflow indicator takes over. Applies on every
   * surface, including the `onChipClick` layout below: a navigable chip cannot
   * live INSIDE the trigger, but it is still this cell that draws it, so a
   * crowded row cannot grow without bound anywhere.
   */
  maxVisible?: number;
  /** Routes a chip press somewhere other than the picker (Documents' search). */
  onChipClick?: (tag: TagSummary) => void;
  tags: TagSummary[];
  /**
   * ISS-12452: the client this row's OWN reads are cached in, when it differs
   * from the ambient one — Branches injects its own on desktop. See
   * `TagPicker`'s matching prop.
   */
  queryClient?: QueryClient;
  surface: ArtifactStatusEditSurface;
};

const DEFAULT_MAX_VISIBLE_CHIPS = 2;

/**
 * Branches' trigger box, kept verbatim as the shared one: tokens only, and a
 * visible focus ring, because the chips inside it are the only thing marking
 * the control's bounds.
 *
 * Exported (ISS-10332) for the Sessions and Branches priority cells, whose
 * trigger is the same content-sized box in the same rows: `ArtifactPriorityEditor`
 * leaves radius and ring to its caller, and without this a hover paints a
 * hard-edged rectangle mid-cell beside a rounded, ringed Tags trigger.
 */
export const INLINE_CELL_TRIGGER_CLASSES =
  "flex shrink-0 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function EntityTagsCell({
  canApply,
  canRemove,
  editLabel,
  emptyValue = <GridEmptyValue />,
  entityId,
  entityType,
  maxVisible = DEFAULT_MAX_VISIBLE_CHIPS,
  onChipClick,
  tags,
  queryClient,
  surface,
}: Readonly<EntityTagsCellProps>) {
  // A picker that can neither apply nor remove anything is a control that opens
  // and does nothing, so the read-only reader gets the chips themselves. The
  // `canRemove`-only case is included in that: with nothing applied there is
  // nothing the grant reaches.
  const canMutate =
    Boolean(entityId) && (canApply || (canRemove && tags.length > 0));
  if (!(canMutate && entityId)) {
    return tags.length > 0 ? (
      <TagChips maxVisible={maxVisible} tags={tags} />
    ) : (
      emptyValue
    );
  }

  // A chip that navigates is its own `<button>`, and a button cannot nest inside
  // the picker's trigger button — so a surface that routes chip presses gets its
  // chips beside the trigger instead of inside it. Everyone else reads the whole
  // cell as one control. What does NOT change with the layout is who draws the
  // chips: asking `TagPicker` for its own applied-chip run is what let Documents
  // out of the cap, so the run is `TagChips` either way.
  const chipsRideBesideTheTrigger = Boolean(onChipClick);
  const chips = (
    <TagChips maxVisible={maxVisible} onChipClick={onChipClick} tags={tags} />
  );

  const picker = (
    <TagPicker
      appliedTags={tags}
      canApply={canApply}
      canRemove={canRemove}
      entityId={entityId}
      entityType={entityType}
      queryClient={queryClient}
      showAppliedChips={false}
      showCreate={canApply}
      surface={surface}
      trigger={
        <button
          aria-label={editLabel}
          className={INLINE_CELL_TRIGGER_CLASSES}
          onClick={(event) => event.stopPropagation()}
          type="button"
        >
          {chipsRideBesideTheTrigger ? null : chips}
          {canApply ? (
            <PlusIcon aria-hidden className="size-3.5 text-muted-foreground" />
          ) : null}
        </button>
      }
    />
  );

  return chipsRideBesideTheTrigger ? (
    <div className="flex min-w-0 items-center gap-1">
      {chips}
      {picker}
    </div>
  ) : (
    picker
  );
}
