/**
 * @file autonomy.ts
 * @description Session autonomy scoring — attended-time attribution (FEA-3781).
 *
 * Split out of `derivation.ts`, which is otherwise about Session Trace
 * PRESENTATION: phases, throttles, correction markers, PR lifecycle. "How much
 * of this session ran without a human present" is a different question with its
 * own constants, its own wire-visible version stamp, and its own consumers — the
 * desktop sync lane imports `AUTONOMY_FORMULA_VERSION` and the calibration
 * harness imports `deriveAutonomyAndSteering`, neither of which wants the
 * trace-presentation surface. `deriveSessionTracePresentation` composes this
 * module; nothing here reaches back.
 */

import {
  type AutonomyTier,
  classifyAutonomyTier,
} from "@repo/api/src/session-autonomy-tiers";
import { clamp01 } from "@repo/api/src/utils/math";

export const AutonomyLabel = {
  Unknown: "Unknown",
  Manual: "Manual",
  Mixed: "Mixed",
  Agentic: "Agentic",
} as const;
export type AutonomyLabel = (typeof AutonomyLabel)[keyof typeof AutonomyLabel];

// Consecutive human prompts within this window are one steering intervention
// (the person typed twice, they did not intervene twice). Unchanged since
// FEA-3581 and shared verbatim with the ancestor implementation named in
// `deriveAutonomyAndSteering`'s header — episode grouping was never the defect.
const AUTONOMY_PROMPT_BURST_MS = 90 * 1000;
/**
 * FEA-3781: the most either side is credited for one unwitnessed gap. The
 * PORTION OF A GAP BEYOND THIS is attributed to neither party — nobody was at
 * the session — while the first 30 minutes still counts, because someone
 * plausibly was.
 *
 * It is a cap, not an all-or-nothing exclusion, and that distinction is load
 * bearing. Discarding an over-threshold gap ENTIRELY would hand the overnight
 * case straight back to the old defect: a session with 5 minutes of agent work
 * and a 19-hour gap before the human returned would attribute 5 minutes of work
 * against zero attention and score 100 — exactly the "118-hour session reads as
 * fully autonomous" degeneracy this metric was rewritten to kill. Capping says
 * "we believe someone was there for up to half an hour, and past that we stop
 * believing"; excluding says "none of it happened", which is a stronger and
 * less defensible claim.
 *
 * Applied symmetrically: the same cap bounds a single agent step, so a
 * rate-limit stall or a session resumed the next morning is not banked as half a
 * day of autonomous work.
 */
const AUTONOMY_IDLE_GAP_MS = 30 * 60 * 1000;

/**
 * FEA-3781: revision stamp for the autonomy formula, used by the desktop sync
 * lane to decide whether already-uploaded sessions need re-sending.
 *
 * Autonomy is computed at SYNC-PAYLOAD BUILD time, not at import time, and it is
 * not persisted in the local store — so nothing about a formula change makes a
 * session's `updated_at` move, and the durable keyset cursor would walk straight
 * past every historical row. Without this stamp the cloud keeps serving the old
 * score forever and the fix looks like it did not work. `DATA_REVISION` cannot
 * carry this: it re-derives rows FROM the transcript, and none of those rows
 * change here.
 *
 * BUMP THIS whenever `deriveAutonomyAndSteering` changes the score it returns
 * for unchanged input. Do not bump it for comment or refactor churn — each bump
 * costs one full-corpus re-upload per installed client.
 *
 *   1 — FEA-3581: `0.6 * unattendedFraction + 0.4 * steeringScore`.
 *   2 — FEA-3781: attended-time attribution (the current formula).
 */
export const AUTONOMY_FORMULA_VERSION = 2;

export type AutonomyInput = {
  /** `role:"human"` turn timestamps — genuine human steering only. */
  promptTimestamps: readonly string[];
  /**
   * FEA-3781: timestamps of AGENT activity only — every timeline row that is not
   * a human prompt, plus token events. It must exclude prompts: the deriver has
   * to distinguish "the agent worked last" from "the human spoke last", and with
   * a combined stream it structurally cannot (a trailing prompt becomes the last
   * activity, collapsing every agent-working span to nothing).
   */
  agentActivityTimestamps: readonly string[];
  // FEA-2870: when the calling params mark the session as headless/autonomous,
  // its prompts are injected by a driver rather than typed by a person, so no
  // wall time is attributed to human attention (see the header).
  headless?: boolean;
  /**
   * FEA-3781: whether the session is finished. Only consulted when nothing is
   * measurable yet — a still-running session reports unknown there instead of a
   * hard 0, because the payload is rebuilt on every sync tick and mid-turn is
   * indistinguishable from "the agent never answered". Defaults to `true`
   * (measure it); the live desktop path passes `endedAt != null`.
   */
  sessionEnded?: boolean;
};

/**
 * FEA-3781: this module's label vocabulary, expressed over the canonical tiers.
 * It previously restated its own `< 35` / `< 70` boundaries, which silently
 * disagreed with `AUTONOMY_TIER_MIN_SCORE` for the whole time that constant sat
 * at 88/70 — the same score read "Agentic" here and "Mixed" in the sessions
 * list. Deriving from the classifier makes that class of drift impossible
 * rather than merely currently-absent.
 */
const AUTONOMY_LABEL_BY_TIER: Record<AutonomyTier, AutonomyLabel> = {
  unknown: AutonomyLabel.Unknown,
  guided: AutonomyLabel.Manual,
  mixed: AutonomyLabel.Mixed,
  high: AutonomyLabel.Agentic,
};

/**
 * Convert numeric autonomy into the canonical user-facing bucket. The score
 * remains nullable in transport; labels are derived at render/projection time.
 * The boundaries live in `AUTONOMY_TIER_MIN_SCORE` (`@repo/api`), not here.
 */
export function getAutonomyLabel(
  score: number | null | undefined
): AutonomyLabel {
  return AUTONOMY_LABEL_BY_TIER[classifyAutonomyTier(score)];
}

/**
 * Score how much of a session ran without a human present, as ATTENDED-TIME
 * ATTRIBUTION (FEA-3781). Every millisecond of the session is put in exactly one
 * of three states, and the score is the agent's share of the two that count:
 *
 *   agent working   a prompt -> its last agent activity              numerator + denominator
 *   human attending that last activity -> the next prompt            denominator only
 *   idle / away     a gap's excess beyond AUTONOMY_IDLE_GAP_MS       neither
 *
 *   autonomy = round(100 * agentWorking / (agentWorking + humanAttending))
 *
 * STEERING IS PRICED HERE, NOT AS A SECOND TERM. Every human intervention
 * necessarily opens a human-attending span — the person had to read the output,
 * decide, and type. More steering means more attended time means a lower score,
 * as one number. Do not "helpfully" reintroduce a steering term: the previous
 * formula only needed one because its primary term measured the wrong thing.
 *
 * What this replaces and why (FEA-3781): FEA-3581 scored the fraction of WALL
 * time that fell outside a prompt episode. A prompt episode is instantaneous
 * (`start === end` for a single prompt), so essentially the whole session lay
 * outside one and that fraction was very nearly a constant. Measured over a real
 * 119-session corpus, 87% of scored sessions landed on exactly 100, the minimum
 * was 60, and the lowest tier was unreachable. Worse, its steering term divided
 * interventions by the wall span INCLUDING overnight idle, so a longer, more
 * heavily steered session scored HIGHER — the four most heavily steered sessions
 * in that corpus all scored exactly 100. The human's read/think/type gap was
 * being credited to the agent; measuring it directly is the fix. Re-run
 * `pnpm -C apps/desktop calibrate:autonomy` to reproduce either distribution.
 *
 * Ratio, not duration: a fully autonomous 2-minute run and a fully autonomous
 * 2-hour run both score 100. That was FEA-3581's intent and it is preserved,
 * without its duration-coupled steering term.
 *
 * DIVERGENCE (deliberate): `summarizeSessionAutonomy` in `closedloop-ai/workflow`
 * (`packages/telemetry/src/report.ts`) is this function's ancestor and shares its
 * episode grouping, burst window, and tier vocabulary — but scores a blend of
 * median stretch length, long-stretch share, and steering pressure. It therefore
 * penalizes a fast autonomous run, which is the defect FEA-3581 forked to fix.
 * The two repos do NOT agree and are not meant to; reconciling them is a separate
 * decision (PLN-1545 "Prior art"), not a drift to quietly repair here.
 *
 * Returns `null` autonomy only when the session carries no usable evidence —
 * never because the shape confused the formula. A session where the human
 * prompted and the agent never worked scores 0 (Manual), which is the truthful
 * answer, not "unknown".
 */
export function deriveAutonomyAndSteering(input: AutonomyInput): {
  autonomy: number | null;
  steeringEpisodes: number | null;
} {
  const promptTimes = sortedFiniteTimes(input.promptTimestamps);
  const agentTimes = sortedFiniteTimes(input.agentActivityTimestamps);
  if (promptTimes.length === 0 && agentTimes.length === 0) {
    // An empty shell: no prompts, no agent activity, nothing to measure.
    return { autonomy: null, steeringEpisodes: null };
  }

  const episodes = groupPromptEpisodes(promptTimes);
  if (episodes.length === 0) {
    // FEA-2870: a headless run's prompts are injected by a driver, so having
    // none is expected and the run is autonomous by construction. For an
    // interactive session it means the human turns were not captured — the
    // deriver cannot tell "nobody steered" from "we failed to record it", so it
    // reports unknown rather than asserting a perfect score. (The ancestor named
    // above draws the same line via its `hasEstimate: false`.)
    return input.headless
      ? { autonomy: 100, steeringEpisodes: 0 }
      : { autonomy: null, steeringEpisodes: null };
  }

  // A headless run's injected prompts are not human steering, so they are
  // reported as zero interventions AND contribute no attended time below.
  const steeringEpisodes = input.headless
    ? 0
    : Math.max(0, episodes.length - 1);
  const attribution = attributeAutonomySpans({
    promptTimes,
    agentTimes,
    // The session extends to whichever came last, the agent or the human.
    sessionEndMs: Math.max(
      agentTimes.at(-1) ?? Number.NEGATIVE_INFINITY,
      promptTimes.at(-1) ?? Number.NEGATIVE_INFINITY
    ),
    headless: input.headless === true,
  });
  const attributedMs =
    attribution.agentWorkingMs + attribution.humanAttendingMs;
  if (attributedMs <= 0) {
    // Prompts exist but no measurable agent work followed any of them — the
    // agent never responded, or every row shares the prompt's own timestamp.
    //
    // For an INTERACTIVE session that is evidence of non-autonomy: a person
    // demonstrably prompted and nothing came back, so the truthful score is the
    // bottom of the scale, NOT null (FEA-3781: null must mean "no data", never
    // "no work").
    //
    // For a HEADLESS run it is not. There was no human — the prompts were
    // injected by a driver — so 0/Manual would assert a person drove a run
    // nobody attended. It stays fully agentic, matching the no-prompts headless
    // branch above and this function's stated contract. The unmeasurable case is
    // the whole reason that contract exists: a headless run whose lone injected
    // prompt shares its first agent row's timestamp has no elapsed span to
    // attribute, and its autonomy is a property of how it was launched.
    //
    // And for a session STILL RUNNING it is not either. The sync payload is
    // rebuilt on every tick, so between the prompt landing and the agent's first
    // output there is a window where this looks identical to "the agent never
    // responded" — and answering 0 there renders "Manual | 0/100" about a
    // session nobody has measured yet, and moves the row out of the Unknown
    // facet into Guided for a reason that is not autonomy. That is a
    // loading-vs-true-zero conflation; unknown is the honest answer until the
    // session is over. It self-corrects on the next sync either way.
    if (input.headless) {
      return { autonomy: 100, steeringEpisodes: 0 };
    }
    return input.sessionEnded === false
      ? { autonomy: null, steeringEpisodes }
      : { autonomy: 0, steeringEpisodes };
  }
  return {
    autonomy: Math.round(
      clamp01(attribution.agentWorkingMs / attributedMs) * 100
    ),
    steeringEpisodes,
  };
}

function sortedFiniteTimes(values: readonly string[]): number[] {
  return values
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

function groupPromptEpisodes(times: readonly number[]): {
  start: number;
  end: number;
}[] {
  const episodes: { start: number; end: number }[] = [];
  for (const time of times) {
    const current = episodes.at(-1);
    if (current && time - current.end <= AUTONOMY_PROMPT_BURST_MS) {
      current.end = time;
      continue;
    }
    episodes.push({ start: time, end: time });
  }
  return episodes;
}

/**
 * FEA-3781: split a session's wall time into agent-working and human-attending
 * milliseconds, discarding idle. Walks INDIVIDUAL prompts in order; each opens a
 * window running to the next prompt (or the session end). Inside a window the
 * agent works from the prompt until its last output, and the human attends from
 * that output until they speak again.
 *
 * Deliberately NOT over prompt episodes. An episode is a 90-second burst, and
 * attributing from the burst's END discarded any agent work that happened
 * between two prompts inside it: prompt -> reply 30s later -> follow-up at 60s
 * collapsed to one episode ending at 60s, so the reply vanished and a session
 * with real work could score 0. Walking raw prompts costs nothing and prices
 * that interleaved reply correctly. Episodes still define `steeringEpisodes` —
 * a burst is one intervention — which is why `groupPromptEpisodes` stays.
 *
 * Both streams are pre-sorted, so a single cursor walks the agent timestamps
 * once across all windows rather than re-scanning per prompt.
 */
function attributeAutonomySpans(input: {
  promptTimes: readonly number[];
  agentTimes: readonly number[];
  sessionEndMs: number;
  headless: boolean;
}): { agentWorkingMs: number; humanAttendingMs: number } {
  let agentWorkingMs = 0;
  let humanAttendingMs = 0;
  let cursor = 0;
  for (let index = 0; index < input.promptTimes.length; index++) {
    const promptMs = input.promptTimes[index];
    if (promptMs === undefined) {
      continue;
    }
    const windowEndMs = input.promptTimes[index + 1] ?? input.sessionEndMs;
    const worked = attributeAgentWindow({
      windowStartMs: promptMs,
      windowEndMs,
      agentTimes: input.agentTimes,
      fromIndex: cursor,
    });
    agentWorkingMs += worked.agentWorkingMs;
    cursor = worked.nextIndex;
    if (input.headless) {
      continue;
    }
    // Whatever is left of the window after the agent's last output is the person
    // reading it and deciding what to say next. Capped, so a session left open
    // overnight stops accruing attention 30 minutes in rather than reading as a
    // human sitting there all night.
    humanAttendingMs += Math.min(
      Math.max(0, windowEndMs - (worked.lastAgentMs ?? promptMs)),
      AUTONOMY_IDLE_GAP_MS
    );
  }
  return { agentWorkingMs, humanAttendingMs };
}

/**
 * FEA-3781: agent-working milliseconds inside one post-prompt window
 * `(windowStartMs, windowEndMs]`, plus where the agent's work ended.
 *
 * Consecutive agent timestamps bound the work; each step is capped at
 * {@link AUTONOMY_IDLE_GAP_MS} so a long stall inside the agent's own turn (a
 * rate-limit wait, a session resumed the next morning) is discarded rather than
 * banked as autonomous work. Timestamps at or before `windowStartMs` are skipped
 * — an agent row sharing the prompt's exact millisecond is session scaffolding,
 * not a response to it, and contributes no elapsed work either way.
 */
function attributeAgentWindow(input: {
  windowStartMs: number;
  windowEndMs: number;
  agentTimes: readonly number[];
  fromIndex: number;
}): { agentWorkingMs: number; lastAgentMs: number | null; nextIndex: number } {
  let agentWorkingMs = 0;
  let previousMs = input.windowStartMs;
  let lastAgentMs: number | null = null;
  let index = input.fromIndex;
  while (index < input.agentTimes.length) {
    const stamp = input.agentTimes[index];
    if (stamp === undefined || stamp > input.windowEndMs) {
      break;
    }
    if (stamp > input.windowStartMs) {
      agentWorkingMs += Math.min(stamp - previousMs, AUTONOMY_IDLE_GAP_MS);
      previousMs = stamp;
      lastAgentMs = stamp;
    }
    index++;
  }
  return { agentWorkingMs, lastAgentMs, nextIndex: index };
}
