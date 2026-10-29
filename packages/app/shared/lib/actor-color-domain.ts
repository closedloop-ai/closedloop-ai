import { DEFAULT_HUMAN_ACTOR_COLOR_TOKEN } from "@repo/api/src/agent-session-user-color";
import {
  CHART_COLOR_PAIR_TOKEN_INDEXES,
  CHART_OTHER_SERIES_COLOR,
  type ChartColorPair,
  chartColorPair,
  chartColorPairForColor,
} from "@repo/design-system/components/ui/chart-colors";

/**
 * The one actor → colour-token mapping for BOTH traces: the single-session trace
 * (`@repo/app/agents`) and the multi-session Branch trace (`@repo/app/branches`).
 *
 * Every actor-bearing mark — chart stacks, their legend, and trace turns — seats
 * an actor here, so the same actor cannot render one colour on one trace and a
 * different colour on the other. Domains still differ in how they ORDER actors
 * (the Branch swimlane lanes by session actor, the cost timeline by human owner,
 * a single-session trace has one human), but ordering is identity resolution;
 * the colour a seat carries is decided only here.
 *
 * Event dots are deliberately NOT actors (ISS-8656): they keep their
 * event-semantic status colours and never read this module.
 */
export const ActorTurnSide = {
  Human: "human",
  Agent: "agent",
} as const;
export type ActorTurnSide = (typeof ActorTurnSide)[keyof typeof ActorTurnSide];

/**
 * The seat an actor whose identity did not resolve takes.
 *
 * A NEUTRAL, not the next categorical hue. A hue is a claim of identity, and
 * "we could not attribute this" has none to make — the same reason
 * `CHART_OTHER_SERIES_COLOR` is a neutral rather than an eleventh series colour.
 * Anchored to `DEFAULT_HUMAN_ACTOR_COLOR_TOKEN` — the hue the API and the
 * desktop projection already emit for an unresolved owner — so the producers and
 * these charts speak one neutral rather than two.
 */
export const UNKNOWN_ACTOR_COLOR_PAIR: ChartColorPair = {
  // `base` and `soft` are what a chart band and a single-colour surface actually
  // paint, and they take the design system's own measured neutral for a band
  // with no identity (3.49:1 light / 4.36:1 dark against the card). The generic
  // 62%-toward-background pair recipe is tuned for saturated hues and drops this
  // grey to 2.96:1 in light mode, under the 3:1 non-text floor — which is the
  // very reason `CHART_OTHER_SERIES_COLOR` mixes at 70% toward the surface.
  // `strong` mixes toward the foreground, so it only gains contrast.
  base: CHART_OTHER_SERIES_COLOR,
  soft: CHART_OTHER_SERIES_COLOR,
  strong: chartColorPairForColor(DEFAULT_HUMAN_ACTOR_COLOR_TOKEN).strong,
};

/** Attributed seats available before the palette has to repeat a colour. */
const ADDITIONAL_ACTOR_SEATS = Math.max(
  1,
  CHART_COLOR_PAIR_TOKEN_INDEXES.length - 1
);

/**
 * Colour pair for the actor seated at `slot`, or the neutral when no seat
 * resolved. Slot 0 is the primary actor and is never shifted, so the primary
 * actor of a trace reads the same on every chart regardless of `paletteOffset`;
 * the offset rotates only the additional seats, which is what keeps two domains
 * over DIFFERENT entity kinds (a human user vs a session actor) out of each
 * other's colour band.
 */
export function actorColorPairForSlot(
  slot: number | null | undefined,
  paletteOffset = 0
): ChartColorPair {
  if (slot == null || !Number.isFinite(slot) || slot < 0) {
    return UNKNOWN_ACTOR_COLOR_PAIR;
  }
  const seat = Math.trunc(slot);
  if (seat === 0) {
    return chartColorPair(0);
  }
  return chartColorPair(
    ((seat - 1 + paletteOffset) % ADDITIONAL_ACTOR_SEATS) + 1
  );
}

/** Side-aware actor colour for a trace turn, an activity bar, or a lane. */
export function actorColorForTurn(
  pair: ChartColorPair,
  side: ActorTurnSide
): string {
  return side === ActorTurnSide.Human ? pair.soft : pair.strong;
}
