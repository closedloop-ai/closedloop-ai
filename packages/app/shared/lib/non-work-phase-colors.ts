/**
 * ISS-4790 — the one muted-grey sub-palette for the three NON-WORK activity
 * buckets, shared by the session activity strip/breakdown
 * (`agents/lib/session-activity-phases.ts`) and the branch cost-to-merge bar
 * (`branches/lib/activity-taxonomy-display.ts`).
 *
 * The two surfaces legitimately own DIFFERENT chart palettes for the named work
 * phases (`explore` is `--chart-5` on the session strip and `--chart-1` on the
 * branch bar), but these three greys were byte-identical copies in both files,
 * each docstring pointing at the other as the reason for its values. That is a
 * single value with two declarations — retune it in one place and the panels
 * silently stop matching — so it lives here instead.
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
