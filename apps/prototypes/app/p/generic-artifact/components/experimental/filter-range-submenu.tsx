"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FilterMenuGroup, FilterRangeGroup } from "./table-filters";

/** Whether a generic menu group contributes to the applied-filter count. */
export function isFilterMenuGroupActive(group: FilterMenuGroup): boolean {
  if (group.kind === "range") {
    return group.min !== undefined || group.max !== undefined;
  }
  return group.selectedValues.length > 0;
}

/**
 * Fixed-size slot for a submenu row's leading icon. Shared with `FilterPopover`
 * so the range facet's leading visual lines up pixel-for-pixel with the options
 * facets' icons.
 */
export function LeadingVisual({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-[18px] shrink-0 items-center justify-center">
      {children}
    </span>
  );
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
 * `min` only ⇒ `500+`; `max` only ⇒ `≤ 50`; both ⇒ `0 – 50`.
 */
export function formatRangeValue(
  min: number | undefined,
  max: number | undefined
): string | null {
  if (min !== undefined && max !== undefined) {
    return `${min} – ${max}`;
  }
  if (min !== undefined) {
    return `${min}+`;
  }
  if (max !== undefined) {
    return `≤ ${max}`;
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
 */
export function RangeSubmenu({
  group,
  clearLabel,
}: {
  group: FilterRangeGroup;
  clearLabel: string;
}) {
  const rangeValue = formatRangeValue(group.min, group.max);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {group.icon ? <LeadingVisual>{group.icon}</LeadingVisual> : null}
        <span className="flex-1">{group.label}</span>
        {rangeValue ? (
          <span className="text-muted-foreground text-xs">{rangeValue}</span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className={group.submenuClassName ?? "w-56"}>
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
