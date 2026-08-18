/**
 * FEA-2275 — the single canonical `phase → {label, color}` display map for the
 * session-activity taxonomy (explore / plan / implement / review / validate /
 * rework / idle / other). One source of truth consumed by
 * `SessionActivityBreakdown`, the session-detail timeline phase bands, AND the
 * FEA-2276 branch rollup — so phase labels and colors never drift across
 * surfaces. Colors reference the shared `--chart-*` palette (defined once in the
 * design system) so light/dark theming is handled centrally; `idle`/`other` are
 * intentionally muted so the honest remainders read as secondary, not as work.
 *
 * ISS-4790: the LABELS are no longer declared here — they come from the shared
 * `ACTIVITY_PHASE_LABEL` map so the session and branch breakdowns can never spell
 * the same bucket two different ways. This module owns only the session-surface
 * colors.
 */
import {
  ACTIVITY_PHASE_LABEL,
  UNKNOWN_ACTIVITY_PHASE_LABEL,
} from "@repo/api/src/activity-phase-labels";
import { labelize } from "@repo/api/src/utils/string";
import { NON_WORK_PHASE_GREY } from "../../shared/lib/non-work-phase-colors";

export type PhaseDisplay = {
  /** Human display label for the phase. */
  label: string;
  /** CSS color for the phase swatch / bar segment / band (a theme token var). */
  colorVar: string;
};

export const SESSION_ACTIVITY_PHASE_DISPLAY: Record<string, PhaseDisplay> = {
  explore: { label: ACTIVITY_PHASE_LABEL.explore, colorVar: "var(--chart-5)" },
  plan: { label: ACTIVITY_PHASE_LABEL.plan, colorVar: "var(--chart-1)" },
  implement: {
    label: ACTIVITY_PHASE_LABEL.implement,
    colorVar: "var(--chart-2)",
  },
  review: { label: ACTIVITY_PHASE_LABEL.review, colorVar: "var(--chart-4)" },
  validate: {
    label: ACTIVITY_PHASE_LABEL.validate,
    colorVar: "var(--chart-3)",
  },
  rework: { label: ACTIVITY_PHASE_LABEL.rework, colorVar: "var(--chart-6)" },
  idle: {
    label: ACTIVITY_PHASE_LABEL.idle,
    colorVar: NON_WORK_PHASE_GREY.idle,
  },
  other: {
    label: ACTIVITY_PHASE_LABEL.other,
    colorVar: NON_WORK_PHASE_GREY.other,
  },
  /**
   * Not a classifier phase — the client-synthesized residual the session
   * breakdown falls back to when a session has NO tiling at all
   * (`buildFallbackSegment`). It gets an entry here so that row renders the same
   * word and the same muted weight as the branch panel's `unattributed` row,
   * which the branch rollup fills from exactly those sessions. Without it the
   * row titleized onto the unknown-phase chart color and read as a real phase.
   */
  unattributed: {
    label: ACTIVITY_PHASE_LABEL.unattributed,
    colorVar: NON_WORK_PHASE_GREY.unattributed,
  },
};

/** Stable fallback color for a phase key outside the known taxonomy. */
const FALLBACK_COLOR_VAR = "var(--chart-7)";

/**
 * Display for a phase key, tolerant of taxonomy growth: the classifier taxonomy
 * can grow via a version bump (a `phase` is a bounded free string, not a closed
 * union), so an unknown key titleizes rather than crashing or rendering blank,
 * and takes a stable fallback color.
 */
export function getPhaseDisplay(key: string): PhaseDisplay {
  // `key` is a bounded free string (the classifier `phase`, not a closed
  // union), so guard with Object.hasOwn before indexing: a key like
  // "constructor" / "__proto__" would otherwise resolve to an inherited
  // Object.prototype member, making `known` truthy and returning an object with
  // undefined label/color instead of taking the titleize fallback.
  if (Object.hasOwn(SESSION_ACTIVITY_PHASE_DISPLAY, key)) {
    return SESSION_ACTIVITY_PHASE_DISPLAY[key]!;
  }
  return { label: titleizePhaseKey(key), colorVar: FALLBACK_COLOR_VAR };
}

function titleizePhaseKey(key: string): string {
  // ONE titleization rule for the whole taxonomy: the same `labelize` the branch
  // display map uses, so a compound classifier key like `auto-review` reads
  // "Auto Review" on every surface rather than "Auto Review" on branch detail
  // and "Auto-review" here. A key with no word in it at all (empty, or only
  // separators) takes the same canonical unnameable label the wire producer
  // uses for that case.
  return labelize(key) || UNKNOWN_ACTIVITY_PHASE_LABEL;
}

/**
 * Stable DOM anchors for the Activity breakdown's phase cell and for the phase
 * NAME inside it (ISS-4674).
 *
 * They exist because below the `@sm/breakdown` container breakpoint the panel
 * folds the provenance word into that SAME cell, so the cell's text content
 * reads "Implementdeclared" and no element carries the bare phase name. A text
 * locator therefore matches NOTHING at exactly the phone width this fix is
 * about — while jsdom still matches, because Testing Library's `getNodeText`
 * joins only an element's direct text-node children and skips nested elements,
 * whereas Playwright matches on the full subtree text. That divergence is what
 * let the unit suite stay green while the Chromium spec went red.
 *
 * The two are a PAIR and must be used together:
 * - `PhaseName` identifies which phase a row is, with no provenance word mixed
 *   in, so a spec can say "this row is Implement".
 * - `PhaseCell` is the grid item that owns the flexible phase TRACK. The track's
 *   width — not the glyph width of a short name like "Idle" — is what collapsed
 *   to a bare color swatch in the ticket, so width assertions belong here.
 *
 * Shared with the web (`e2e/`) and desktop (`apps/desktop/test/e2e/`) layout
 * guards, which both drive this panel, so the markup and its specs cannot drift.
 * Kept in this lightweight, import-free module rather than on the component so
 * a Node-side Playwright spec can read them without pulling in React.
 */
export const ActivityBreakdownSlot = {
  PhaseCell: "activity-phase",
  PhaseName: "activity-phase-name",
  /**
   * ISS-5000 — the per-row Cost cell. Named so a spec can assert the invariant
   * that made this panel wrong: the column is presented as the decomposition of
   * the header figure, so the values it RENDERS must sum to the value the header
   * renders. Anchoring on the slot rather than on a currency-shaped text match
   * keeps that assertion from also sweeping up the header total, the footer, or
   * a future money column.
   */
  CostCell: "activity-phase-cost",
} as const;
export type ActivityBreakdownSlot =
  (typeof ActivityBreakdownSlot)[keyof typeof ActivityBreakdownSlot];

/**
 * ISS-4685 — the Activity breakdown's share column has TWO honest names, one per
 * basis, because the column itself has two bases: it is a share of per-phase
 * COST when that spend is priced and trustworthy (the common case), and a share
 * of wall TIME only when per-phase cost is unavailable.
 *
 * It used to render a single unqualified "Share", which named neither. In the
 * priced mode nothing else on screen named it either, while the Time column and
 * the "Active work: X% of Y" footer framed the whole panel in time — so two
 * phases with equal Time and unequal share (the reported repro) read as a
 * contradiction rather than as a cost split. Renaming it once would only have
 * moved the lie: a fixed "Cost share" is wrong in the cost-unavailable mode. The
 * panel picks between these off the same flag its share MATH uses, so the label
 * cannot claim a basis the column is not computing.
 *
 * Deliberately abbreviated rather than "Cost share" / "Time share": the column's
 * grid track is a fixed `3.25rem` in both of the panel's column sets (sized in
 * ISS-4674 so the panel fits a 390px phone) and the header cells truncate, so a
 * longer label would ship as "Cost sh…". That track was `2.75rem` (44px) while
 * the column said the unqualified "Share"; these labels measure ~38-39px at 12px,
 * which cleared 44px only until a reader bumped their font size — at which point
 * an abbreviation that abbreviates ITSELF away ("Cost…") leaves them worse off
 * than the bare "Share" did. The track therefore grew with the label, to 52px;
 * the flexible phase track absorbs the extra half-rem in both sets. The
 * unabbreviated basis is spelled out in the panel footer instead, which is also
 * the only carrier a screen reader gets — the header row is `aria-hidden`. The
 * two names are the same shape with the noun swapped, so the column reads as one
 * column in two units rather than as two unrelated things.
 *
 * Lives in this lightweight, React-free module for the same reason
 * {@link ActivityBreakdownSlot} does: the web (`e2e/`) and desktop
 * (`apps/desktop/test/e2e/`) layout guards assert on this column and must read
 * the label from the one place that defines it, without importing the component.
 */
export const SHARE_COLUMN_LABEL = {
  cost: "Cost %",
  time: "Time %",
} as const;
export type ShareColumnLabel =
  (typeof SHARE_COLUMN_LABEL)[keyof typeof SHARE_COLUMN_LABEL];
