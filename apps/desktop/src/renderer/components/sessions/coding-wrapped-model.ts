import type { AgentCoachingGroundedMetrics } from "./agent-coaching-types";

/**
 * One "Coding Wrapped" fun-fact card derived from the already-computed lookback
 * metrics (FEA-3403). Purely presentational data (no secrets, no raw evidence),
 * so it is safe to render and (later) export. Each fact reads on typography
 * alone: a quiet eyebrow, a headline value, an optional caption. No emoji or
 * decorative glyph, that reads as designed-by-AI, not as polish.
 */
export type CodingWrappedCard = {
  /** Stable key for React lists and dismiss/telemetry hooks. */
  id: string;
  /** Short uppercase eyebrow, e.g. "Top model". */
  label: string;
  /** The headline value, e.g. "claude-opus-4" or "42%". */
  value: string;
  /** One-line supporting caption; omitted when there is nothing to add. */
  caption?: string;
};

const PERCENT = 100;
const MODEL_SHARE_MIN_TO_SHOW = 0.01;
const PROMPT_PREVIEW_MAX_CHARS = 64;
// Mirrors the lookback's NIGHT_OWL_LABEL_THRESHOLD: at/above this the cadence
// label leads with "night owl: N%…", below it leads with a peak-activity phrase
// ("most active around 3pm on Tuesday"). The card keys its headline off the same
// boundary so the eyebrow and the label can never describe different things.
const NIGHT_OWL_HEADLINE_THRESHOLD = 0.25;

function toPercent(ratio: number): string {
  return `${Math.round(ratio * PERCENT)}%`;
}

/**
 * The favorite-model card: the highest-token-share model over the window. Hidden
 * when there is no per-model attribution, or when the top model's share is
 * negligible (nothing worth celebrating).
 */
function modelCard(
  modelMix: AgentCoachingGroundedMetrics["modelMix"]
): CodingWrappedCard | null {
  if (!modelMix || modelMix.length === 0) {
    return null;
  }
  const [top] = modelMix;
  if (top.share < MODEL_SHARE_MIN_TO_SHOW) {
    return null;
  }
  return {
    caption: `${toPercent(top.share)} of your tokens across ${top.sessions} ${
      top.sessions === 1 ? "session" : "sessions"
    }`,
    id: "wrapped-top-model",
    label: "Top model",
    value: top.model,
  };
}

/**
 * The cadence card. `sessionCadence.label` is a human-readable string
 * precomputed by the lookback that leads with "night owl: N%…" for a night owl
 * and with a peak-activity phrase ("most active around 3pm on Tuesday")
 * otherwise. To keep the eyebrow and the label coherent, a night owl gets an
 * "After midnight: N%" headline with the label as caption; everyone else gets a
 * "When you code" card whose headline IS the peak-activity label (no
 * after-midnight % that would contradict a daytime label).
 */
function cadenceCard(
  sessionCadence: AgentCoachingGroundedMetrics["sessionCadence"]
): CodingWrappedCard | null {
  if (!sessionCadence) {
    return null;
  }
  if (sessionCadence.nightOwlRatio >= NIGHT_OWL_HEADLINE_THRESHOLD) {
    return {
      caption: sessionCadence.label,
      id: "wrapped-cadence",
      label: "After midnight",
      value: toPercent(sessionCadence.nightOwlRatio),
    };
  }
  return {
    id: "wrapped-cadence",
    label: "When you code",
    value: sessionCadence.label,
  };
}

/**
 * The plan-mode card. `planModeRatio` is null (undetectable) — never a false
 * `false` — when no plan-mode marker appears at all, so the card is hidden
 * rather than claiming "0% plan mode" for a harness that just does not surface
 * the marker.
 */
function planModeCard(
  planModeRatio: AgentCoachingGroundedMetrics["planModeRatio"]
): CodingWrappedCard | null {
  if (planModeRatio == null) {
    return null;
  }
  return {
    caption: "of sessions started with a plan",
    id: "wrapped-plan-mode",
    label: "Plan mode",
    value: toPercent(planModeRatio),
  };
}

/**
 * The most-reached-for-prompt card. Prompt text is already redacted and
 * length-capped by the lookback; we clamp the preview again defensively so the
 * card stays a headline, not a paragraph.
 */
function topPromptCard(
  topPrompts: AgentCoachingGroundedMetrics["topPrompts"]
): CodingWrappedCard | null {
  if (!topPrompts || topPrompts.prompts.length === 0) {
    return null;
  }
  const [top] = topPrompts.prompts;
  const preview =
    top.text.length > PROMPT_PREVIEW_MAX_CHARS
      ? `${top.text.slice(0, PROMPT_PREVIEW_MAX_CHARS).trimEnd()}…`
      : top.text;
  return {
    caption: `asked ${top.count} ${top.count === 1 ? "time" : "times"}`,
    id: "wrapped-top-prompt",
    label: "Top prompt",
    value: preview,
  };
}

/**
 * Build the Coding Wrapped deck from the lookback metrics — one card per
 * available signal, in a stable order, skipping any signal that is absent
 * (null/empty). Returns an empty deck when nothing is available so the caller
 * can hide the whole surface. Pure and deterministic: no DB, no clock, no
 * randomness, so it is directly unit-testable.
 */
export function buildWrappedCards(
  metrics: AgentCoachingGroundedMetrics | null
): CodingWrappedCard[] {
  if (!metrics) {
    return [];
  }
  const candidates = [
    modelCard(metrics.modelMix),
    cadenceCard(metrics.sessionCadence),
    planModeCard(metrics.planModeRatio),
    topPromptCard(metrics.topPrompts),
  ];
  return candidates.filter((card): card is CodingWrappedCard => card !== null);
}
