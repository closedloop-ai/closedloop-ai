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
 *   3 — ISS-7259: `headless` also honours the harness's OWN launch attribution
 *       (agent-spawned thread, or an SDK-injected first prompt), so a run the
 *       harness stated was unattended no longer has to be inferred from the
 *       entrypoint string alone. The arithmetic is unchanged; the input widened,
 *       which moves the score for sessions that were being read as attended.
 */
export const AUTONOMY_FORMULA_VERSION = 3;

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

export type AutonomyAccumulator = {
  pushAgent(timeMs: number): void;
  pushPrompt(timeMs: number): void;
  finish(): { autonomy: number | null; steeringEpisodes: number | null };
};

/**
 * Incremental form of the canonical autonomy formula. Inputs must be finite and
 * chronological; for an equal timestamp, agent activity is pushed before the
 * prompt because attribution windows are `(prompt, nextPrompt]`.
 */
export function createAutonomyAccumulator(input: {
  headless: boolean;
  sessionEnded: boolean;
}): AutonomyAccumulator {
  let agentEvidence = false;
  let promptEvidence = false;
  let previousPromptMs: number | null = null;
  let currentPromptMs: number | null = null;
  let previousAgentMs: number | null = null;
  let lastAgentMs: number | null = null;
  let latestEvidenceMs = Number.NEGATIVE_INFINITY;
  let episodeCount = 0;
  let agentWorkingMs = 0;
  let humanAttendingMs = 0;

  function closeWindow(windowEndMs: number): void {
    if (currentPromptMs === null) {
      return;
    }
    if (!input.headless) {
      humanAttendingMs += Math.min(
        Math.max(0, windowEndMs - (lastAgentMs ?? currentPromptMs)),
        AUTONOMY_IDLE_GAP_MS
      );
    }
  }

  return {
    pushAgent(timeMs) {
      if (!Number.isFinite(timeMs)) {
        return;
      }
      agentEvidence = true;
      latestEvidenceMs = Math.max(latestEvidenceMs, timeMs);
      if (currentPromptMs === null || timeMs <= currentPromptMs) {
        return;
      }
      agentWorkingMs += Math.min(
        timeMs - (previousAgentMs ?? currentPromptMs),
        AUTONOMY_IDLE_GAP_MS
      );
      previousAgentMs = timeMs;
      lastAgentMs = timeMs;
    },
    pushPrompt(timeMs) {
      if (!Number.isFinite(timeMs)) {
        return;
      }
      promptEvidence = true;
      latestEvidenceMs = Math.max(latestEvidenceMs, timeMs);
      closeWindow(timeMs);
      if (
        previousPromptMs === null ||
        timeMs - previousPromptMs > AUTONOMY_PROMPT_BURST_MS
      ) {
        episodeCount += 1;
      }
      previousPromptMs = timeMs;
      currentPromptMs = timeMs;
      previousAgentMs = null;
      lastAgentMs = null;
    },
    finish() {
      if (!(agentEvidence || promptEvidence)) {
        return { autonomy: null, steeringEpisodes: null };
      }
      if (!promptEvidence) {
        return input.headless
          ? { autonomy: 100, steeringEpisodes: 0 }
          : { autonomy: null, steeringEpisodes: null };
      }
      closeWindow(latestEvidenceMs);
      const steeringEpisodes = input.headless
        ? 0
        : Math.max(0, episodeCount - 1);
      const attributedMs = agentWorkingMs + humanAttendingMs;
      if (attributedMs <= 0) {
        if (input.headless) {
          return { autonomy: 100, steeringEpisodes: 0 };
        }
        return input.sessionEnded
          ? { autonomy: 0, steeringEpisodes }
          : { autonomy: null, steeringEpisodes };
      }
      return {
        autonomy: Math.round(clamp01(agentWorkingMs / attributedMs) * 100),
        steeringEpisodes,
      };
    },
  };
}

/** Apply one timestamp's evidence in the formula's canonical tie order. */
export function pushAutonomyEvidenceAtTimestamp(
  accumulator: AutonomyAccumulator,
  timeMs: number,
  evidence: { agent: boolean; prompt: boolean }
): void {
  if (evidence.agent) {
    accumulator.pushAgent(timeMs);
  }
  if (evidence.prompt) {
    accumulator.pushPrompt(timeMs);
  }
}

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
  const accumulator = createAutonomyAccumulator({
    headless: input.headless === true,
    sessionEnded: input.sessionEnded !== false,
  });
  let promptIndex = 0;
  let agentIndex = 0;
  while (promptIndex < promptTimes.length || agentIndex < agentTimes.length) {
    const prompt = promptTimes[promptIndex] ?? Number.POSITIVE_INFINITY;
    const agent = agentTimes[agentIndex] ?? Number.POSITIVE_INFINITY;
    const timeMs = Math.min(prompt, agent);
    let hasAgent = false;
    while (agentTimes[agentIndex] === timeMs) {
      hasAgent = true;
      agentIndex += 1;
    }
    let hasPrompt = false;
    while (promptTimes[promptIndex] === timeMs) {
      hasPrompt = true;
      promptIndex += 1;
    }
    pushAutonomyEvidenceAtTimestamp(accumulator, timeMs, {
      agent: hasAgent,
      prompt: hasPrompt,
    });
  }
  return accumulator.finish();
}

function sortedFiniteTimes(values: readonly string[]): number[] {
  return values
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}
