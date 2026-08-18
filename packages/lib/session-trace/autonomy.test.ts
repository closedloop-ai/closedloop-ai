import {
  AUTONOMY_TIER_MIN_SCORE,
  type AutonomyTier,
  classifyAutonomyTier,
} from "@repo/api/src/session-autonomy-tiers";
import { describe, expect, it } from "vitest";
import {
  AutonomyLabel,
  deriveAutonomyAndSteering,
  getAutonomyLabel,
} from "./autonomy.js";

describe("Session autonomy scoring", () => {
  it("FEA-3781: splits the session into agent-working and human-attending time", () => {
    // Three prompts, each followed by ~4 min of agent work and ~6 min of the
    // human reading the result before the next prompt. 12 min worked, 12 min
    // attended → exactly half the attributable time needed a human present.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:10:00.000Z",
        "2026-06-16T10:20:00.000Z",
      ],
      agentActivityTimestamps: [
        "2026-06-16T10:00:30.000Z",
        "2026-06-16T10:04:00.000Z",
        "2026-06-16T10:10:30.000Z",
        "2026-06-16T10:14:00.000Z",
        "2026-06-16T10:20:30.000Z",
        "2026-06-16T10:24:00.000Z",
      ],
    });

    expect(result.steeringEpisodes).toBe(2);
    expect(result.autonomy).toBe(50);
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Mixed);
  });

  it("FEA-3581/FEA-3781: a single-prompt fast run scores fully agentic", () => {
    // A ~2-minute run: one human prompt, then the agent works to the end with
    // nobody waiting on it. This is the regression guard against re-inheriting
    // the ancestor implementation's speed penalty (`closedloop-ai/workflow`
    // normalizes the median stretch against a fixed 15-min bar, which scored this
    // exact shape ~24/100 and is the defect FEA-3581 forked to fix).
    const result = deriveAutonomyAndSteering({
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      agentActivityTimestamps: [
        "2026-06-16T10:00:30.000Z",
        "2026-06-16T10:01:00.000Z",
        "2026-06-16T10:02:00.000Z",
      ],
    });

    expect(result).toEqual({ autonomy: 100, steeringEpisodes: 0 });
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Agentic);
  });

  it("FEA-3581/FEA-3781: speed alone does not penalize — same ratio, 10x the duration, same score", () => {
    // Identical shape (prompt, agent works, human reads, human prompts again),
    // with the slow run stretched 10x. The score is a ratio of attributed time,
    // so both land on the same value rather than rewarding the longer run.
    const fast = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:02:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:01:00.000Z"],
    });
    const slow = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:20:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:10:00.000Z"],
    });

    expect(fast.autonomy).toBe(50);
    expect(slow.autonomy).toBe(50);
  });

  it("FEA-3781: steering is priced THROUGH attended time, with no steering term", () => {
    // Same 20-minute session, same "agent responds then human reacts" rhythm —
    // only the number of interventions differs. The heavily-steered run scores
    // far lower purely because more of its wall time was spent with a human in
    // the loop. If someone reintroduces a separate steering term, this spread
    // stops being explained by attended time alone.
    const lightlySteered = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:10:00.000Z",
        "2026-06-16T10:20:00.000Z",
      ],
      agentActivityTimestamps: [
        "2026-06-16T10:09:00.000Z",
        "2026-06-16T10:19:00.000Z",
      ],
    });
    const heavilySteered = deriveAutonomyAndSteering({
      promptTimestamps: Array.from({ length: 11 }, (_, index) =>
        new Date(Date.UTC(2026, 5, 16, 10, index * 2)).toISOString()
      ),
      agentActivityTimestamps: Array.from({ length: 10 }, (_, index) =>
        new Date(Date.UTC(2026, 5, 16, 10, index * 2, 30)).toISOString()
      ),
    });

    expect(lightlySteered.steeringEpisodes).toBe(2);
    expect(lightlySteered.autonomy).toBe(90);
    expect(heavilySteered.steeringEpisodes).toBe(10);
    expect(heavilySteered.autonomy).toBe(25);
    // Stated spread: the metric must keep at least this much room between a
    // barely-steered and a heavily-steered run, so a future change that
    // re-flattens it fails here rather than silently shipping.
    expect(
      (lightlySteered.autonomy ?? 0) - (heavilySteered.autonomy ?? 0)
    ).toBeGreaterThanOrEqual(40);
    expect(getAutonomyLabel(heavilySteered.autonomy)).toBe(
      AutonomyLabel.Manual
    );
  });

  it("FEA-3781: idle time is attributed to neither side", () => {
    // The agent finishes at 10:05 and the human comes back the next morning.
    // Only the 30-minute idle cap is charged as attention, not the 19 hours —
    // the overnight-resume dilution that let a 118-hour session read as fully
    // autonomous under the previous formula.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-17T09:00:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:05:00.000Z"],
    });

    // 5 min worked / (5 min worked + 30 min capped attention) = 14%.
    expect(result.autonomy).toBe(14);
  });

  it("FEA-3781: a session that ENDS on a human turn is scored from the work that happened", () => {
    // The originally-reported bug: real interaction, blank score. A trailing
    // prompt used to be the session's last activity, collapsing every unattended
    // stretch to nothing and returning null.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:10:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:05:00.000Z"],
    });

    expect(result).toEqual({ autonomy: 50, steeringEpisodes: 1 });
  });

  it("FEA-3781: a human who prompted and got no agent work scores 0, not unknown", () => {
    // No autonomous work occurred, so the truthful answer is the BOTTOM of the
    // scale. `null` must mean "no usable data", never "the shape confused the
    // formula" — a blank here read as "we have no idea" for a session we know
    // everything about.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:10:00.000Z",
      ],
      agentActivityTimestamps: [],
    });

    expect(result).toEqual({ autonomy: 0, steeringEpisodes: 1 });
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Manual);
  });

  it("FEA-3781: one prompt plus a same-millisecond scaffolding row scores 0", () => {
    // An agent row sharing the prompt's exact timestamp is session scaffolding,
    // not a response to it — no measurable work followed the human.
    const instant = "2026-06-16T10:00:00.000Z";
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [instant],
      agentActivityTimestamps: [instant],
    });

    expect(result).toEqual({ autonomy: 0, steeringEpisodes: 0 });
  });

  it("FEA-3781: an empty shell — no prompts, no agent activity — stays unknown", () => {
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [],
      agentActivityTimestamps: [],
    });

    expect(result).toEqual({ autonomy: null, steeringEpisodes: null });
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Unknown);
  });

  it("FEA-3781: agent activity with no captured prompts stays unknown, not 100", () => {
    // The deriver cannot tell "nobody steered" from "the human turns were not
    // recorded", so it must not assert a perfect score. (The ancestor
    // implementation draws the same line with its `hasEstimate: false`.)
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [],
      agentActivityTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:05:00.000Z",
      ],
    });

    expect(result).toEqual({ autonomy: null, steeringEpisodes: null });
  });

  it("FEA-2870: a headless run scores fully agentic — its injected prompts are not steering", () => {
    // Four driver-injected prompts inside one burst, then agent work. Under the
    // attended-time model a headless run simply has no human-attending span, so
    // 100 falls out of the formula instead of being asserted over it.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:01:00.000Z",
        "2026-06-16T10:02:00.000Z",
        "2026-06-16T10:03:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:03:30.000Z"],
      headless: true,
    });

    expect(result).toEqual({ autonomy: 100, steeringEpisodes: 0 });
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Agentic);
  });

  it("FEA-2870/FEA-3781: an identically-shaped INTERACTIVE run does not score 100", () => {
    // The headless flag is the only difference from the case above. It must
    // still change the answer — a flag that no longer moves the score would make
    // the case above pass for the wrong reason.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:01:00.000Z",
        "2026-06-16T10:02:00.000Z",
        "2026-06-16T10:03:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:03:30.000Z"],
    });

    // One 3-minute prompt burst (the human typing) against 30 s of agent work:
    // 30 / (30 + 180) = 14%.
    expect(result).toEqual({ autonomy: 14, steeringEpisodes: 0 });
  });

  it("FEA-3781: the label vocabulary agrees with the canonical tier boundaries", () => {
    // Two vocabularies, one boundary set. These used to restate the cut-points
    // independently and disagreed for every score in [70, 88) while
    // AUTONOMY_TIER_MIN_SCORE sat at 88/70. Deriving the boundaries in one place
    // is what this asserts — including the exact boundary values, so moving a
    // cut-point without moving both surfaces fails here.
    const expected: Record<AutonomyTier, AutonomyLabel> = {
      unknown: AutonomyLabel.Unknown,
      guided: AutonomyLabel.Manual,
      mixed: AutonomyLabel.Mixed,
      high: AutonomyLabel.Agentic,
    };
    for (const score of [
      null,
      0,
      AUTONOMY_TIER_MIN_SCORE.mixed - 1,
      AUTONOMY_TIER_MIN_SCORE.mixed,
      AUTONOMY_TIER_MIN_SCORE.high - 1,
      AUTONOMY_TIER_MIN_SCORE.high,
      100,
    ]) {
      expect(getAutonomyLabel(score)).toBe(
        expected[classifyAutonomyTier(score)]
      );
    }
    // Pin the tier a mid-scale score lands in, so a future cut-point move is a
    // deliberate edit here rather than a silent reclassification.
    expect(getAutonomyLabel(50)).toBe(AutonomyLabel.Mixed);
    expect(getAutonomyLabel(25)).toBe(AutonomyLabel.Manual);
    expect(getAutonomyLabel(95)).toBe(AutonomyLabel.Agentic);
  });

  it("FEA-3781: an agent reply BETWEEN two prompts in one burst is still counted", () => {
    // Prompt, reply 30 s later, human follow-up at 60 s. Both prompts fall in one
    // 90-second episode, so attributing from the episode's END discarded the
    // reply entirely and this scored 0 despite real work. Attribution walks
    // individual prompts for exactly this reason.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:01:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:00:30.000Z"],
    });

    // 30 s of agent work, then 30 s of the human reading it before following up.
    expect(result.autonomy).toBe(50);
    // The two prompts are still ONE intervention — a 90-second burst is one
    // steering event, and that grouping is shared with the ancestor
    // implementation. Only the time attribution stopped using it.
    expect(result.steeringEpisodes).toBe(0);
  });

  it("FEA-3781: a multi-prompt burst with no reply is all attended, not agent work", () => {
    // The counterpart to the case above: three prompts inside one burst with the
    // agent silent throughout. Walking individual prompts must not credit the
    // typing gaps to the agent.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:00:30.000Z",
        "2026-06-16T10:01:00.000Z",
      ],
      agentActivityTimestamps: ["2026-06-16T10:02:00.000Z"],
    });

    // 60 s of typing attended, then 60 s of agent work to its last output.
    expect(result.autonomy).toBe(50);
  });

  it("FEA-3781: a session still in flight reports unknown, not a hard 0", () => {
    // The sync payload is rebuilt on every tick, so between the prompt landing
    // and the agent's first output this is indistinguishable from "the agent
    // never answered". Answering 0 there would render "Manual | 0/100" about a
    // session nobody has measured yet and move the row from the Unknown facet
    // into Guided for a reason that is not autonomy.
    const live = deriveAutonomyAndSteering({
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      agentActivityTimestamps: [],
      sessionEnded: false,
    });
    const finished = deriveAutonomyAndSteering({
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      agentActivityTimestamps: [],
      sessionEnded: true,
    });

    expect(live).toEqual({ autonomy: null, steeringEpisodes: 0 });
    expect(getAutonomyLabel(live.autonomy)).toBe(AutonomyLabel.Unknown);
    // Once the session is over, the same shape IS a truthful zero.
    expect(finished).toEqual({ autonomy: 0, steeringEpisodes: 0 });
  });

  it("FEA-3781: a headless run with no MEASURABLE work is still fully agentic, not 0", () => {
    // The injected prompt and the only agent row share a timestamp, so there is
    // no elapsed span to attribute. An interactive session in this shape scores
    // 0 (a person prompted and nothing came back — real evidence of
    // non-autonomy); a headless one must not, because there was no person. This
    // is the one unmeasurable case where the launch method, not the clock,
    // decides.
    const instant = "2026-06-16T10:00:00.000Z";
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [instant],
      agentActivityTimestamps: [instant],
      headless: true,
    });

    expect(result).toEqual({ autonomy: 100, steeringEpisodes: 0 });
    // The interactive twin, to prove the flag is what changed the answer.
    expect(
      deriveAutonomyAndSteering({
        promptTimestamps: [instant],
        agentActivityTimestamps: [instant],
      })
    ).toEqual({ autonomy: 0, steeringEpisodes: 0 });
  });

  it("FEA-3781: a headless run with no timestamps at all is unknown, not 100", () => {
    // Contract change from FEA-2870, which returned a hard-coded 100 before
    // looking at the data. A run with nothing recorded is an empty shell whether
    // or not it was launched headlessly; asserting a perfect score for it is the
    // same class of lie this ticket is fixing.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [],
      agentActivityTimestamps: [],
      headless: true,
    });

    expect(result).toEqual({ autonomy: null, steeringEpisodes: null });
  });
});
