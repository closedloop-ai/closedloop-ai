import {
  getTimelineMarkerSemanticLabel,
  TimelineMarkerSemantic,
  type TimelineMarkerSemantic as TimelineMarkerSemanticType,
} from "@repo/app/shared/lib/timeline-marker-semantics";
import type { ActivityMarker } from "./session-timeline-axis";

/**
 * The three dot lanes the activity strip stacks, keyed by the single-letter
 * token the rendered cell uses (`b` steering, `g` delivery, `r` trouble).
 */
export type DotColor = "b" | "g" | "r";

/**
 * Which lane a marker belongs to, or `null` for a marker kind the strip does not
 * plot as a dot.
 *
 * The grouping is by what a reader is scanning FOR, not by event provenance:
 * commits and PRs are both "the session shipped something", failures and rate
 * limits are both "the session was blocked", and prompts and frustration signals
 * are both "a human intervened". Three lanes keep the strip readable at the
 * density a long session produces.
 */
export function getMarkerDotColor(
  kind: ActivityMarker["kind"]
): DotColor | null {
  if (kind === "commit" || kind === "pr") {
    return "g";
  }
  if (kind === "fail" || kind === "limit") {
    return "r";
  }
  if (kind === "prompt" || kind === "frust") {
    return "b";
  }
  return null;
}

/**
 * The theme token a lane paints with, so dots track light/dark like the rest.
 *
 * ISS-10676 / ISS-12117: the Session Timeline's OWN marker tokens, declared in
 * `styles-session-timeline.css` beside the `.sd3-dot` rules that paint the
 * dots, not the shared `--primary`/`--success`/`--destructive` that
 * `getTimelineMarkerSemanticToken` returns. Those collided with the strip's
 * `--chart-*` bars and paired red with green; the Branch timeline still reads
 * the shared ones and is out of this ticket's scope.
 */
export function getDotColorToken(color: DotColor): string {
  if (color === "g") {
    return "var(--sd3-marker-delivery)";
  }
  if (color === "r") {
    return "var(--sd3-marker-failure)";
  }
  return "var(--sd3-marker-steering)";
}

export type DotShape = "circle" | "diamond" | "square";

/**
 * The mark's shape. ISS-12117: every lane gets its own, because colour cannot
 * separate them on its own. All three hues share the one arc the `--chart-*`
 * bars leave free, red and green fold together under deuteranopia and
 * protanopia (ISS-10676), and steering and delivery sit about 0.1 ΔE apart
 * under deuteranopia. Steering is a square, commits and PRs a circle, failures
 * and limits a diamond.
 *
 * ONE source for every surface that draws a mark: the dot rail, the legend,
 * the hover card and the transcript's event bullets all take their class from
 * {@link getDotShapeClassName}, so the key cannot show a shape the strip does
 * not draw.
 */
export function getDotShape(color: DotColor): DotShape {
  if (color === "g") {
    return "circle";
  }
  if (color === "r") {
    return "diamond";
  }
  return "square";
}

/** The class that draws {@link getDotShape} (`styles-session-timeline.css`). */
export function getDotShapeClassName(color: DotColor): string {
  return `sd3-shape-${getDotShape(color)}`;
}

/**
 * The dot's accessible name, which must not promise a jump the dot cannot make.
 *
 * Mirrors `getBucketButtonLabel` in `activity-bucket-rendering.ts` — the bar
 * already drops "Jump to" when it carries no row, and ISS-5479 found the dot six
 * pixels away still claiming it.
 *
 * `withdrawn` is the resolved no-jump state rather than the raw "this marker
 * has no `tl`" fact, so the caller decides it once and the name, the affordance
 * and the click all answer from the same value. ISS-6006 retired the gate that
 * used to hold this false, so the withdrawn name is now unconditional — matching
 * the bar's equivalent, which has been un-gated since ISS-4821.
 */
export function getDotButtonLabel(color: DotColor, withdrawn: boolean): string {
  if (withdrawn) {
    return getDotLabel(color);
  }
  return `Jump to ${getDotLabel(color)}`;
}

/** The lane's human name, used by the dot tooltip and its accessible label. */
export function getDotLabel(color: DotColor): string {
  return getTimelineMarkerSemanticLabel(getDotSemantic(color));
}

/**
 * The inverse direction of {@link getMarkerDotColor}: which marker KIND a
 * persisted timeline row's single-letter `dot` token stands for. Moved here from
 * `agent-session-detail-view.tsx` because it is the
 * other half of this module's job — one place owns the mapping between dot
 * tokens and marker semantics, so the two directions cannot drift apart.
 *
 * `dot` arrives from a synced/persisted row, so it is untrusted at this
 * boundary: an unrecognized or absent token degrades to `prompt` rather than
 * throwing or dropping the marker, which keeps a version-skewed producer's
 * events on the strip instead of silently losing them.
 */
export function getEventMarkerKind(
  dot: string | undefined
): ActivityMarker["kind"] {
  if (dot === "g") {
    return "commit";
  }
  if (dot === "r") {
    return "fail";
  }
  return "prompt";
}

export function getDotSemantic(color: DotColor): TimelineMarkerSemanticType {
  if (color === "g") {
    return TimelineMarkerSemantic.Delivery;
  }
  if (color === "r") {
    return TimelineMarkerSemantic.FailureLimit;
  }
  return TimelineMarkerSemantic.HumanSteering;
}

/**
 * The transcript row a lane's dot jumps to, or `null` when it has none.
 *
 * ONE owner for the no-jump answer, so the affordance and the hover card cannot
 * disagree. The rail draws the dot from this and the tooltip writes its closing
 * line from it, off the same lane array — before ISS-7632's follow-up the rail
 * resolved it inline and the tooltip did not resolve it at all, so a dot could
 * be `aria-disabled` while the card six pixels away still said "click the dot to
 * jump".
 *
 * The first member wins because that is the event the rail's click actually
 * targets; a lane's later events are described in the card but are not the jump.
 *
 * THE INVARIANT THAT MAKES THE LANE'S ORDER SAFE TO CHANGE (ISS-8653): the rail
 * and the hover card read the SAME array — `session-timeline-dot-rail.tsx`
 * resolves the click through this function, and `session-activity-timeline.tsx`
 * hands that identical `cells[bucketIndex][color]` to `EventDotTooltip`. So
 * whichever order built the lane, index 0 is simultaneously the row the click
 * lands on and the row the card prints first, and the card's closing "jump to
 * the first" cannot come to mean a different event than the dot. Re-ordering a
 * lane is therefore a whole-rail decision, never a per-consumer one; a consumer
 * that took its own order would break this and put two answers on the screen.
 */
export function getDotJumpRow(
  events: readonly Omit<ActivityMarker, "x">[]
): number | null {
  return events[0]?.tl ?? null;
}
