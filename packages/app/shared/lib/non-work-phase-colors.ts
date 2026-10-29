/**
 * ISS-4790 — the one muted-grey sub-palette for the three NON-WORK activity
 * buckets, read by the branch cost-to-merge bar
 * (`branches/lib/activity-taxonomy-display.ts`).
 *
 * It was hoisted here because the session phase surface and the branch bar each
 * declared a byte-identical copy. ISS-7867 retired the session surface, so the
 * branch bar is the only consumer today; the values stay here rather than being
 * inlined back, since this is the palette the branch bar's own test pins.
 *
 * `idle`, `other`, and `unattributed` are three DIFFERENT honest remainders that
 * render as adjacent rows and adjacent bar slices, so they must not share one
 * swatch: at the same `var(--muted-foreground)` an idle slice next to an `other`
 * slice painted as one continuous block, showing one bucket where the rows
 * showed two. They are separated by WEIGHT within one muted-foreground family —
 * never bespoke hex — so both themes stay correct and the row label stays the
 * real differentiator.
 */
export const NON_WORK_PHASE_GREY = {
  idle: "color-mix(in oklab, var(--muted-foreground) 34%, transparent)",
  other: "color-mix(in oklab, var(--muted-foreground) 48%, transparent)",
  unattributed: "color-mix(in oklab, var(--muted-foreground) 64%, transparent)",
} as const;
