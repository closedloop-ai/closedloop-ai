"use client";

import type { Priority } from "@repo/api/src/types/common";
import {
  ArtifactPriorityMenu,
  priorityTriggerLabel,
} from "@repo/app/documents/components/artifact-field-menus";
import { ArtifactPriority } from "@repo/app/shared/components/artifact-priority/artifact-priority";
import {
  allowsArtifactPriorityUnset,
  paintsArtifactPriorityAbsentLabel,
} from "@repo/app/shared/components/artifact-priority/artifact-priority-contract";
import {
  type ArtifactPrioritySupport,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { cn } from "@repo/design-system/lib/utils";
import { useState } from "react";

/**
 * ISS-9307 — the one control that changes an artifact's priority.
 *
 * The MARK is `ArtifactPriority`, in the shared slice so the search results and
 * the projects grid can paint a priority without depending on this slice. The
 * interaction lives here, beside `ArtifactPriorityMenu`, which stays the single
 * owner of what the menu offers and in what order.
 *
 * WHOLE-CELL EDITING, NO CARET. The trigger is the cell: the entire mark is the
 * hit target, so there is no separate disclosure glyph competing with the value
 * for the reader's eye. `DropdownMenuTrigger` publishes `aria-haspopup="menu"`
 * and toggles `aria-expanded`, which is what tells a screen reader the mark is
 * a control — the caret never was.
 *
 * WHERE ROLLBACK LIVES, and why not here. The editor renders the `priority` it
 * is handed and keeps no accepted copy of its own. The authoritative value is
 * the server's, and the optimistic display plus the rollback on refusal belong
 * to `useArtifactRowEdit`, which runs every field through the design system's
 * `useCommitLedger`. A second optimistic copy here would fight that ledger and
 * could put back a value the server had already refused.
 */
export function ArtifactPriorityEditor({
  className,
  disabled,
  mutationActivity,
  onSelect,
  priority,
  readOnly,
  support,
  variant = ArtifactPriorityVariant.Editor,
}: {
  className?: string;
  disabled?: boolean;
  /** A write for this row's priority is in flight. */
  mutationActivity?: boolean;
  /** Absent when the surface supplies no commit path, which is read-only. */
  onSelect?: (priority: Priority | null) => void;
  priority: string | null;
  readOnly?: boolean;
  /**
   * The surface's own declaration from `ARTIFACT_PRIORITY_SUPPORT`. An
   * UNSUPPORTED surface never gets a control, whatever else the caller passes:
   * the operator ruling of 2026-09-11 is that priority is an artifact field, and
   * a shared component that grew a control on a surface carrying no priority
   * column is exactly how that ruling would be widened by accident.
   */
  support: ArtifactPrioritySupport;
  /** Which mark the trigger wraps. The grid and a detail row want different geometry. */
  variant?: ArtifactPriorityVariant;
}) {
  const [open, setOpen] = useState(false);

  const mark = (
    <ArtifactPriority
      disabled={disabled}
      editing={open}
      mutationActivity={mutationActivity}
      priority={priority}
      variant={variant}
    />
  );

  if (!(support.supported && onSelect) || readOnly || disabled) {
    return (
      <span className={className} data-slot="artifact-priority-read-only">
        {mark}
      </span>
    );
  }

  return (
    <ArtifactPriorityMenu
      allowUnset={allowsArtifactPriorityUnset(support)}
      onOpenChange={setOpen}
      onSelect={onSelect}
      trigger={
        <button
          // The mark can be a bare glyph, and on an unset grid row it is a dash,
          // so the control carries a name of its own: the current value, or "Set
          // priority" when there is none. That it OPENS something is published by
          // the Radix trigger's `aria-haspopup="menu"` and `aria-expanded`, not by
          // this string and never by a caret.
          //
          // Withheld where the mark states the absence IN WORDS, because an
          // `aria-label` overrides the contents it sits over: WCAG 2.5.3 (Label
          // in Name) requires the accessible name to contain the visible label,
          // and "Set priority" over a visible "No priority" leaves a
          // voice-control user unable to activate what they can read (ISS-9441).
          // A value that IS set keeps the label — "Priority: High" contains the
          // visible "High" and adds the field the word belongs to.
          aria-label={
            priority === null && paintsArtifactPriorityAbsentLabel(variant)
              ? undefined
              : priorityTriggerLabel(priority)
          }
          // Radius and focus ring are the CALLER's, deliberately. Both absorbed
          // surfaces already own theirs — the grid cell is square with a left
          // divider and keeps the browser's own ring, the artifact row supplies
          // `CHIP_FOCUS_RING_CLASS` — so a default here would round a square cell
          // and replace a ring nobody asked it to.
          className={cn(
            "flex min-w-0 items-center hover:bg-muted/50",
            className
          )}
          onClick={(event) => {
            // The row underneath navigates; picking a priority must not also
            // open the artifact.
            event.stopPropagation();
          }}
          type="button"
        >
          {mark}
        </button>
      }
    />
  );
}
