"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowRightIcon,
  CloudIcon,
  CloudOffIcon,
  LaptopIcon,
} from "lucide-react";
import { DATA_SYNC_LEVEL_COPY } from "../lib/data-sync-copy";

/**
 * ISS-12522: what one data-sync level does with each data category, drawn as
 * collection on this device and upload to the cloud.
 *
 * Every category is collected locally at every level, so the device side always
 * holds one mark per category; the cloud side holds a filled mark only for the
 * categories the level uploads, and an empty slot for the rest. The marks are
 * read from {@link DATA_SYNC_LEVEL_COPY}'s per-line breakdown — the same rows
 * the card prints beneath it — so the picture and the words cannot disagree,
 * and each level's picture is its own because its lines are.
 *
 * Decorative to assistive tech, deliberately. The card's rows are the text
 * equivalent (WCAG 1.4.1): each already names its category and says, in words,
 * whether it syncs to the cloud or stays on this device. Naming the picture
 * too made a screen reader hear the whole breakdown twice inside one radio
 * label. A host that shows this without those rows owes its own equivalent.
 *
 * Uploaded marks are neutral foreground, not the brand accent: on a consent
 * choice, colour must not reward the most-exposed level, which is the same
 * reason `DataLineRow` draws a synced line in plain foreground.
 *
 * CONSENT GATE — no production host may pass this to the card yet. The first
 * production opt-in is blocked until ISS-7775 and ISS-7777 settle the
 * Metadata tier's open claims (`data-sync-copy.ts`: the "Tool inputs & file
 * contents" line is unsettled in both directions, and `session.name` /
 * `agents[].name` still leave). A row that reads "stays on this device" is one
 * claim; an empty cloud slot beside it is a much stronger "nothing here
 * leaves", so drawing it before those land would picture a consent statement
 * we know is not true. Prototypes and Storybook only until then.
 */
export function DataSyncLevelVisual({
  className,
  level,
}: {
  className?: string;
  level: DataSyncLevel;
}) {
  const copy = DATA_SYNC_LEVEL_COPY[level];
  const uploads = copy.dataLines.some((line) => line.kind === "sync");
  const CloudGlyph = uploads ? CloudIcon : CloudOffIcon;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg bg-muted/40 px-3 py-2",
        className
      )}
      data-level={level}
      data-slot="data-sync-level-visual"
    >
      <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex flex-1 gap-1">
        {copy.dataLines.map((line) => (
          <span
            className="h-2 flex-1 rounded-full bg-muted-foreground/45"
            data-collected=""
            key={line.label}
          />
        ))}
      </span>
      {/* Off keeps the arrow's width so the halves line up across cards, but
          draws nothing in it: an arrow toward the cloud contradicts "nothing
          leaves". */}
      <span className="flex size-3.5 shrink-0">
        {uploads ? (
          <ArrowRightIcon className="size-3.5 text-foreground" />
        ) : null}
      </span>
      <span className="flex flex-1 gap-1">
        {copy.dataLines.map((line) => (
          <span
            className={cn(
              "h-2 flex-1 rounded-full",
              line.kind === "sync"
                ? "bg-foreground/80"
                : "border border-muted-foreground/60 border-dashed"
            )}
            data-cloud-slot=""
            data-uploaded={line.kind === "sync" || undefined}
            key={line.label}
          />
        ))}
      </span>
      <CloudGlyph
        className={cn(
          "size-4 shrink-0",
          uploads ? "text-foreground" : "text-muted-foreground"
        )}
      />
    </span>
  );
}
