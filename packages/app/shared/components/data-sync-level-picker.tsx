"use client";

import {
  DATA_SYNC_LEVELS,
  type DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { cn } from "@repo/design-system/lib/utils";
import { useId } from "react";
import { DATA_SYNC_LEVEL_COPY } from "../lib/data-sync-copy";
import { DataSyncLevelCard } from "./data-sync-level-card";

/**
 * THE control for choosing a data-sync level. Every surface that asks "how much
 * of my data goes to the cloud?" renders this one component: the desktop
 * Settings "Data & Sync" tab, the onboarding consent step, and the ISS-5489
 * post-auth takeover.
 *
 * ISS-6147: those surfaces used to be two components that happened to render the
 * same cards — a `RadioGroup` + map in the Settings tab, and a `fieldset` of
 * native radios in onboarding. Every shared property had to be extracted and
 * then policed: ISS-5318 moved the CHIP out after "Recommended" ended up on two
 * different levels, and the ORDER drifted opposite the moment Settings led with
 * the recommended level. Extracting one more property, or adding one more test
 * that the two agree, is not the fix — there is one component now, so there is
 * nothing left to keep in sync.
 *
 * The host supplies its SUBSET of levels (onboarding omits `redacted`; Settings
 * gates it behind a Labs flag) and its selection. It does not supply the order,
 * the chip, the copy, or the radio semantics: the cards render in
 * {@link DATA_SYNC_LEVELS} order — which is declared most-permissive first, so
 * nothing here sorts or reverses — filtered to what the host offers.
 */
export function DataSyncLevelPicker<T extends DataSyncLevel>({
  levels,
  selected,
  onSelect,
  label,
  className,
  disabled,
}: {
  /** Which levels this surface offers, in any order — the picker sorts them. */
  levels: readonly T[];
  /** The current selection, or `null` before a surface has read one. */
  selected: T | null;
  onSelect: (level: T) => void;
  /** Accessible name for the group. Surfaces name it for their own context. */
  label: string;
  className?: string;
  /**
   * Locks the whole group, for a surface holding it while a write is in flight.
   * A dimming class is not that: `pointer-events: none` stops a mouse and lets
   * a keyboard straight through, so a roving-tabindex group styled as inert
   * still fires `onSelect` on an arrow key.
   */
  disabled?: boolean;
}) {
  // Ids are per-mounted-instance, so two pickers on screen at once cannot share
  // a field id. Radix's RadioGroup is a roving-tabindex group rather than a set
  // of native radios, so there is also no DOCUMENT-global `name` for two
  // instances to collide on — the ISS-5489 bug where the browser kept one input
  // checked across both surfaces WITHOUT firing React's onChange cannot be
  // expressed here. The independence itself is covered by test, not left to this
  // comment.
  const fieldPrefix = useId();

  return (
    <RadioGroup
      aria-label={label}
      className={cn("flex flex-col gap-2.5", className)}
      disabled={disabled}
      onValueChange={(value) => onSelect(value as T)}
      value={selected ?? ""}
    >
      {DATA_SYNC_LEVELS.filter((level) => levels.includes(level as T)).map(
        (level) => (
          <DataSyncLevelCard
            control={
              // Named by its title so the accessible name is crisp ("Off",
              // "Metadata only", "Full transcripts") rather than the whole card
              // body; the description, per-line breakdown and caveat stay in the
              // label's subtree for a screen reader moving through the card.
              <RadioGroupItem
                aria-label={DATA_SYNC_LEVEL_COPY[level].title}
                className="mt-0.5"
                id={`${fieldPrefix}-${level}`}
                value={level}
              />
            }
            htmlFor={`${fieldPrefix}-${level}`}
            key={level}
            level={level}
            selected={selected === level}
          />
        )
      )}
    </RadioGroup>
  );
}
