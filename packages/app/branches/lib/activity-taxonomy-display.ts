import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { labelize } from "@repo/api/src/utils/string";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import { NON_WORK_PHASE_GREY } from "../../shared/lib/non-work-phase-colors";

/**
 * FEA-2276: the canonical label + color for each FEA-2269 activity taxonomy phase
 * (+ the branch-rollup `unattributed` residual) — the SINGLE display map the
 * branch cost-to-merge panel renders from, replacing the old build/rework-only
 * `PHASE_COLOR`/`PHASE_LABEL` pair.
 *
 * Colors are DESIGN-SYSTEM TOKENS, never bespoke hex, so the panel themes
 * correctly in light AND dark (the chrome around the bar already flips): the five
 * active-work phases use the shared categorical chart palette (`--chart-*`, tuned
 * per-theme), matching how the Branch timeline + token-cost split color their
 * series (see `packages/app/styles.css`: "not bespoke hex"). Hues are spread
 * around the wheel so adjacent taxonomy rows stay distinguishable. Two buckets
 * keep their SEMANTICS: `rework` is the app's danger red (`--destructive`) so
 * "spend that went backwards" reads as such, and the non-work buckets
 * (`other`/`idle`/`unattributed`) share the muted-foreground grey family — the
 * same treatment the session-detail activity strip uses for idle/unavailable
 * spans — differentiated only by weight, with the row label carrying the meaning.
 *
 * The session-detail activity surface (FEA-2275) colors its segments by KIND
 * (`active`/`idle`/`unavailable`, via `data-kind` CSS) rather than per-phase, so
 * this is the first per-phase display map in the app. Keep it the ONE definition
 * if that surface later adopts per-phase colors. `phase` on the wire is a bounded
 * free string, so `getActivityPhaseDisplay` degrades gracefully (title-cased
 * label, neutral swatch) for an unknown/newer classifier phase rather than
 * throwing or dropping it.
 *
 * ISS-4790: the LABELS come from the shared `ACTIVITY_PHASE_LABEL` map, not from
 * literals here, so the branch bar and the session breakdown can never spell the
 * same bucket two different ways. This module owns only the branch-surface
 * colors. `other` and `unattributed` stay SEPARATE labels on purpose — see the
 * key docs on `@repo/lib/branches/activity-rollup`: `other` is spend the
 * classifier tiled but could not classify, `unattributed` is spend it never saw.
 */
export type ActivityPhaseDisplay = {
  label: string;
  /** Themed CSS color (a design-system token / token-derived value, never hex). */
  color: string;
};

const ACTIVITY_PHASE_DISPLAY: Record<string, ActivityPhaseDisplay> = {
  [BranchVisibleLifecyclePhase.Build]: {
    label: labelize(BranchVisibleLifecyclePhase.Build),
    color: "var(--chart-1)",
  },
  explore: { label: ACTIVITY_PHASE_LABEL.explore, color: "var(--chart-1)" },
  plan: { label: ACTIVITY_PHASE_LABEL.plan, color: "var(--chart-7)" },
  implement: { label: ACTIVITY_PHASE_LABEL.implement, color: "var(--chart-3)" },
  review: { label: ACTIVITY_PHASE_LABEL.review, color: "var(--chart-8)" },
  validate: { label: ACTIVITY_PHASE_LABEL.validate, color: "var(--chart-5)" },
  rework: { label: ACTIVITY_PHASE_LABEL.rework, color: "var(--destructive)" },
  other: {
    label: ACTIVITY_PHASE_LABEL.other,
    color: NON_WORK_PHASE_GREY.other,
  },
  idle: { label: ACTIVITY_PHASE_LABEL.idle, color: NON_WORK_PHASE_GREY.idle },
  [UNATTRIBUTED_KEY]: {
    label: ACTIVITY_PHASE_LABEL.unattributed,
    color: NON_WORK_PHASE_GREY.unattributed,
  },
};

/** Neutral (themed) swatch for a classifier phase not (yet) in the display map. */
const UNKNOWN_PHASE_COLOR = NON_WORK_PHASE_GREY.other;

/**
 * Title-case an unknown/custom phase key for an honest fallback label. Reuses the
 * shared `labelize` (splits on `-`/`_`/`:`, title-cases each part) so a compound
 * classifier phase like `auto-review` reads "Auto Review", not "Auto-review"; an
 * empty/separator-only key falls back to the canonical catch-all label.
 */
function fallbackLabel(phase: string): string {
  return labelize(phase) || ACTIVITY_PHASE_LABEL.other;
}

/**
 * Resolve a normalized rollup phase key (or `unattributed`) to its display label
 * and color, with a graceful fallback for phases the taxonomy grows to include.
 */
export function getActivityPhaseDisplay(phase: string): ActivityPhaseDisplay {
  // `phase` is a bounded free string (the classifier key, not a closed union),
  // so guard with Object.hasOwn before indexing — same guard the two sibling
  // resolvers use (`getPhaseDisplay`, `getCanonicalPhaseLabel`). A key like
  // "constructor" would otherwise resolve to an inherited Object.prototype
  // member, which is truthy, so `??` would never fire and the row would render
  // an undefined label and color instead of the titleized fallback.
  if (Object.hasOwn(ACTIVITY_PHASE_DISPLAY, phase)) {
    return ACTIVITY_PHASE_DISPLAY[phase]!;
  }
  return { label: fallbackLabel(phase), color: UNKNOWN_PHASE_COLOR };
}
