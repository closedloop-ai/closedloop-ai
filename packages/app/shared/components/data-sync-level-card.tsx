"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";
import {
  DATA_SYNC_LEVEL_COPY,
  type DataSyncLevelValue,
  ELEVATED_DATA_SYNC_LEVEL_VALUE,
} from "../lib/data-sync-copy";
import { DataLineRow } from "./data-line-row";

/**
 * ONE card for one data-sync level, rendered by every surface that asks the
 * "how much of my data goes to the cloud?" question: the desktop Settings
 * "Data & Sync" tab, the onboarding consent step, and the ISS-5489 post-auth
 * takeover.
 *
 * ISS-5318: the three surfaces previously shared only the COPY module
 * (`data-sync-copy.ts`) and each drew its own card, so the chip was a per-host
 * decision — and they diverged, with Settings badging "Recommended" on the
 * most-permissive level while onboarding badged it on the safest one. Same word,
 * two levels, and no type could catch it. The card now owns the chip (see
 * {@link dataSyncLevelBadge}) and reads title, description, per-line egress and
 * caveat from the copy SSOT, so a host CANNOT relabel one surface without
 * relabelling all of them.
 *
 * The radio control itself stays with the host: Settings drives a Radix
 * `RadioGroupItem` and the consent surfaces drive a native `<input type="radio">`
 * whose `name` isolates concurrently-mounted groups. Those are genuinely
 * different controls; the card is the part that must not differ.
 */
export function DataSyncLevelCard({
  level,
  selected,
  control,
  htmlFor,
  className,
}: {
  level: DataSyncLevelValue;
  /** Whether this level is the host's current selection — drives the tint + ring. */
  selected: boolean;
  /** The radio input this card labels, rendered by the host. */
  control: ReactNode;
  /** Set when `control` carries an `id` rather than being wrapped by the label. */
  htmlFor?: string;
  className?: string;
}) {
  const copy = DATA_SYNC_LEVEL_COPY[level];

  return (
    <label
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors",
        // The selected card carries the tint AND a ring — on three tall cards
        // the ring is what tells you which one you actually picked.
        selected
          ? "border-primary/40 bg-primary/5 ring-3 ring-primary/15"
          : "border-border hover:border-primary/25",
        className
      )}
      htmlFor={htmlFor}
    >
      {control}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{copy.title}</span>
          {dataSyncLevelBadge(level)}
        </span>
        {/* Description sits above the muted xs caveat in the type hierarchy so
            the benefit and the trade-off do not read as one flat block. */}
        <span className="text-foreground/80 text-sm leading-relaxed">
          {copy.description}
        </span>
        <span className="mt-3 flex flex-col gap-1.5">
          {copy.dataLines.map((line) => (
            <DataLineRow
              as="span"
              key={line.label}
              kind={line.kind}
              label={line.label}
            />
          ))}
        </span>
        {copy.caveat ? (
          <span className="mt-2.5 text-muted-foreground text-xs">
            {copy.caveat}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/**
 * The chip a level carries, product-wide, or `null` for a level that carries
 * none. THE single source of truth for the word and the level it points at.
 *
 * ISS-5318: exactly one level is endorsed — the most-permissive one — in the
 * design-system's approved green, with no icon. It deliberately does not take a
 * host or surface argument: a per-surface override is what let "Recommended"
 * mean two different levels depending on which screen you were looking at.
 */
export function dataSyncLevelBadge(level: DataSyncLevelValue): ReactNode {
  if (level === ELEVATED_DATA_SYNC_LEVEL_VALUE) {
    return <Badge variant="success">Recommended</Badge>;
  }
  return null;
}
