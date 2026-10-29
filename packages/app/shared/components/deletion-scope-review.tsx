"use client";

import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Label } from "@repo/design-system/components/ui/label";
import { cn } from "@repo/design-system/lib/utils";
import { FolderIcon, MessageSquareIcon } from "lucide-react";
import { useId } from "react";

/**
 * ISS-12537 (PRD-808, data controls flow 4): what a deletion, or a request for
 * one, covers. It renders inside the shared `DeleteConfirmationDialog`
 * through that dialog's `scopeReview` prop, never as a dialog of its own, so
 * the confirm/cancel behavior, pending state and responsive Dialog/Sheet swap
 * stay the one shipped implementation (AC-003).
 *
 * Scope, decided for the prototype (posted on ISS-12537): the sessions and
 * directories the user selected. The user can narrow it by unchecking items
 * (AC-001), and confirming with nothing in scope is disabled.
 *
 * The four effect lines (AC-002) are required props, one per consequence:
 * local copies, server data, shared access and future re-upload. This
 * component authors none of that copy and implies no guarantee. What a
 * deletion actually does to each is subject to technical verification
 * (PRD-796); there is no deletion endpoint yet (PRD-808). The prototype only
 * shows whatever statements the host passes.
 *
 * The list uses the design-system `Checkbox` and `Label` primitives. A nested
 * directory/session tree could move to the design-system `CheckboxTree` once
 * it is on main (PR #8818); the flat list is what the prototype needs today.
 */

export const DELETION_SCOPE_ITEM_KIND = {
  SESSION: "session",
  DIRECTORY: "directory",
} as const;

export type DeletionScopeItemKind =
  (typeof DELETION_SCOPE_ITEM_KIND)[keyof typeof DELETION_SCOPE_ITEM_KIND];

export type DeletionScopeItem = {
  id: string;
  kind: DeletionScopeItemKind;
  /** The item's name, e.g. a directory path or a session title. */
  label: string;
  /** Optional supporting line, e.g. a session's date or a directory's size. */
  detail?: string;
};

/** One consequence line: a short label and the host's statement of effect. */
export type DeletionEffect = {
  label: string;
  statement: string;
};

/**
 * The four consequences every deletion review states (AC-002). All four are
 * required, so a host cannot ship a review that is silent on one of them.
 */
export type DeletionEffects = {
  localCopies: DeletionEffect;
  serverData: DeletionEffect;
  sharedAccess: DeletionEffect;
  futureReupload: DeletionEffect;
};

/** The order the effects are read in, fixed so every review reads alike. */
const DELETION_EFFECT_ORDER = [
  "localCopies",
  "serverData",
  "sharedAccess",
  "futureReupload",
] as const satisfies readonly (keyof DeletionEffects)[];

export type DeletionScopeReviewProps = {
  items: readonly DeletionScopeItem[];
  /** Controlled: the ids currently in scope. */
  selectedIds: readonly string[];
  /** Called with the new ids in scope, in `items` order. */
  onSelectedIdsChange: (selectedIds: string[]) => void;
  /** The list's accessible name and visible legend. */
  scopeLabel: string;
  /** The effects section's heading. */
  effectsLabel: string;
  effects: DeletionEffects;
};

const KIND_ICON = {
  [DELETION_SCOPE_ITEM_KIND.SESSION]: MessageSquareIcon,
  [DELETION_SCOPE_ITEM_KIND.DIRECTORY]: FolderIcon,
} as const;

export function DeletionScopeReview({
  items,
  selectedIds,
  onSelectedIdsChange,
  scopeLabel,
  effectsLabel,
  effects,
  className,
  disabled = false,
}: DeletionScopeReviewProps & {
  className?: string;
  /**
   * Locks the scope while a confirmed deletion is in flight, so the list
   * cannot drift from the scope that was submitted. The dialog passes its
   * `isPending`.
   */
  disabled?: boolean;
}) {
  const idPrefix = useId();
  const effectsHeadingId = `${idPrefix}-effects`;
  const selected = new Set(selectedIds);

  const setItemInScope = (itemId: string, inScope: boolean) => {
    onSelectedIdsChange(
      items
        .filter((item) =>
          item.id === itemId ? inScope : selected.has(item.id)
        )
        .map((item) => item.id)
    );
  };

  return (
    <div
      className={cn("space-y-4", className)}
      data-testid="deletion-scope-review"
    >
      <fieldset className="min-w-0 space-y-2" disabled={disabled}>
        <legend className="mb-2 font-medium text-sm">{scopeLabel}</legend>
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
          {items.map((item, index) => {
            const checkboxId = `${idPrefix}-item-${index}`;
            const Icon = KIND_ICON[item.kind];
            return (
              <li
                className="flex items-start gap-2 rounded px-1 py-1.5"
                data-kind={item.kind}
                key={item.id}
              >
                <Checkbox
                  checked={selected.has(item.id)}
                  className="mt-0.5"
                  disabled={disabled}
                  id={checkboxId}
                  onCheckedChange={(checked) =>
                    setItemInScope(item.id, checked === true)
                  }
                />
                <Label
                  className="min-w-0 flex-1 items-start font-normal leading-snug"
                  htmlFor={checkboxId}
                >
                  <Icon
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0">
                    <span className="block break-words">{item.label}</span>
                    {item.detail ? (
                      <span className="block text-muted-foreground text-xs">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                </Label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <section aria-labelledby={effectsHeadingId} className="space-y-2">
        <h3 className="font-medium text-sm" id={effectsHeadingId}>
          {effectsLabel}
        </h3>
        <dl className="space-y-2 text-sm">
          {DELETION_EFFECT_ORDER.map((key) => (
            <div data-effect={key} key={key}>
              <dt className="font-medium">{effects[key].label}</dt>
              <dd className="text-muted-foreground">
                {effects[key].statement}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
