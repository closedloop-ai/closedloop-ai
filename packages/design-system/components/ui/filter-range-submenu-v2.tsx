"use client";

// Grid Table v2 promotion candidate, copied from the approved Generic Artifact prototype.
// SUPERSEDED FORK despite the suffix: `filter-range-submenu.tsx` is the champion
// (ISS-9341, scripts/lint/ledgers/filter-control-families-ledger.ts).
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import { useEffect, useRef, useState } from "react";
import type { FilterMenuGroup, FilterRangeGroup } from "./table-filters-v2";

/** Whether a generic menu group contributes to the applied-filter count. */
export function isFilterMenuGroupActive(group: FilterMenuGroup): boolean {
  if (group.kind === "range") {
    return group.min !== undefined || group.max !== undefined;
  }
  return group.selectedValues.length > 0;
}

/** Parses a range input's raw text into a numeric bound (empty ⇒ undefined). */
export function parseRangeInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Formats the applied range for the trigger row so a closed submenu still shows
 * what is filtered (a count of "1" would hide whether it is `0 – 50` or `500+`).
 * `min` only ⇒ `500+`; `max` only ⇒ `≤ 50`; both ⇒ `0 – 50`. A non-finite bound
 * is no bound: typing a prop `number` does not stop `NaN`/`±Infinity` reaching this
 * shared render boundary, and a label must never state a bound the user never set.
 */
export function formatRangeValue(
  min: number | undefined,
  max: number | undefined
): string | null {
  const lower = Number.isFinite(min) ? min : undefined;
  const upper = Number.isFinite(max) ? max : undefined;
  if (lower !== undefined && upper !== undefined) {
    return `${lower} – ${upper}`;
  }
  if (lower !== undefined) {
    return `${lower}+`;
  }
  if (upper !== undefined) {
    return `≤ ${upper}`;
  }
  return null;
}

/**
 * Numeric min/max range facet submenu (FEA-4003). Two text inputs (numeric
 * `inputMode`, so no native spinner arrows / wheel-scroll mutation) plus a clear
 * action. Raw keystrokes are held locally and only committed on blur/Enter, so
 * an in-progress entry never clobbers the sibling bound or fights the user with
 * per-keystroke clamping; the host owns the normalization applied in `onChange`.
 * The trigger row shows the applied range value rather than a bare count.
 *
 * ISS-8068 — `Escape` closes THIS submenu and returns focus to the row that
 * opened it, per the APG menu pattern ("Escape closes the submenu and returns
 * focus to the parent menu item"). Radix's own default is to close the entire
 * menu tree and hand focus back to the root trigger, which is the wrong
 * granularity: dismissing the whole filter menu to leave one facet costs the
 * user every other facet they had configured, and `Escape` is the only exit
 * they have, because the range inputs consume `ArrowLeft`/`ArrowRight` for
 * caret movement so Radix's sub-close key never reaches the submenu.
 *
 * That trap is NOT unique to this facet, and the fix is deliberately not
 * widened past it here. Every `OptionsSubmenu` in `filter-popover-v2.tsx`
 * renders a `SubMenuSearch` whose `onKeyDown` calls `stopPropagation()`
 * unconditionally, so the assignee, status, priority and tag facets swallow the
 * sub-close key exactly the same way. ISS-8068's acceptance criteria name only
 * the range submenu, and giving every facet a scoped `Escape` changes what
 * "Escape dismisses the filter popover" means for the menu as a whole — a
 * product call rather than an implementation one, so it is raised on the PR
 * instead of taken here. Until it is answered this menu has one facet that
 * scopes its dismissal and several that do not.
 *
 * `preventDefault` on the escape event is what suppresses Radix's
 * close-everything handler: it composes this handler first and skips its own
 * once the event is defaulted-prevented.
 */
export function RangeSubmenu({
  group,
  clearLabel,
}: {
  group: FilterRangeGroup;
  clearLabel: string;
}) {
  const rangeValue = formatRangeValue(group.min, group.max);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenuSub onOpenChange={setOpen} open={open}>
      <DropdownMenuSubTrigger ref={triggerRef}>
        <span className="flex-1">{group.label}</span>
        {rangeValue ? (
          <span className="text-muted-foreground text-xs">{rangeValue}</span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          className={group.submenuClassName ?? "w-56"}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }}
        >
          <RangeFilterContent clearLabel={clearLabel} group={group} />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/** Direct range controls for callers that already provide the submenu shell. */
export function RangeFilterContent({
  group,
  clearLabel,
}: {
  group: FilterRangeGroup;
  clearLabel: string;
}) {
  const active = group.min !== undefined || group.max !== undefined;
  const minInputId = `${group.id}-range-min`;
  const maxInputId = `${group.id}-range-max`;
  const minInputRef = useRef<HTMLInputElement>(null);
  const [minDraft, setMinDraft] = useState(toDraft(group.min));
  const [maxDraft, setMaxDraft] = useState(toDraft(group.max));

  useEffect(() => setMinDraft(toDraft(group.min)), [group.min]);
  useEffect(() => setMaxDraft(toDraft(group.max)), [group.max]);

  const commit = () =>
    group.onChange({
      min: parseRangeInput(minDraft),
      max: parseRangeInput(maxDraft),
    });
  const commitKey = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      commit();
    }
  };

  return (
    <>
      <RangeAutoFocus inputRef={minInputRef} />
      <div className="flex flex-col gap-2 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label
              className="text-muted-foreground text-xs"
              htmlFor={minInputId}
            >
              Min
            </Label>
            <Input
              className="h-8"
              id={minInputId}
              inputMode="numeric"
              onBlur={commit}
              onChange={(event) => setMinDraft(event.target.value)}
              onKeyDown={commitKey}
              placeholder={group.minPlaceholder}
              ref={minInputRef}
              type="text"
              value={minDraft}
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label
              className="text-muted-foreground text-xs"
              htmlFor={maxInputId}
            >
              Max
            </Label>
            <Input
              className="h-8"
              id={maxInputId}
              inputMode="numeric"
              onBlur={commit}
              onChange={(event) => setMaxDraft(event.target.value)}
              onKeyDown={commitKey}
              placeholder={group.maxPlaceholder ?? "Any"}
              type="text"
              value={maxDraft}
            />
          </div>
        </div>
        {active ? (
          <Button
            className="h-7 self-start px-2"
            onClick={() => group.onChange({ min: undefined, max: undefined })}
            size="sm"
            type="button"
            variant="ghost"
          >
            {clearLabel}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/**
 * Focuses the given input once, after Radix's own submenu-open focus settles
 * (a `requestAnimationFrame` defers past FocusScope's initial grab). Rendered
 * only while the submenu content is mounted, so this fires per open. Renders
 * nothing.
 */
function RangeAutoFocus({
  inputRef,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  useEffect(() => {
    const handle = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(handle);
  }, [inputRef]);
  return null;
}

/** Renders a committed bound as input text (`undefined` ⇒ empty string). */
function toDraft(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}
