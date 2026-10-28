import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGeneratedTips } from "../agent-coaching-generate-parse";
import {
  buildAgentCoachingLlmRequest,
  renderAgentCoachingPrompt,
} from "../agent-coaching-llm";
import {
  computePeakFrustration,
  groundedMetricsHaveActivity,
  hasSubstantiveCoachingActivity,
  summarizeLookback,
} from "../agent-coaching-lookback";
import type { AgentCoachingInput } from "../agent-coaching-types";
import {
  errorEvent,
  GENERATED_AT,
  localIso,
  makeAnalyticsWithoutPerDayCost,
  makeGroupedTokenInput,
  makeInput,
  makeInputWithTokens,
  makeWorkflow,
  planEvent,
  promptEvent,
  shellEvent,
  timestampedEvent,
  toolEvent,
  userEvent,
} from "./fixtures/agent-coaching-input";
import { useGermanDefaultLocale } from "./german-default-locale";

describe("summarizeLookback", () => {
  it("windows token totals from per-day history and derives grounded metrics", () => {
    const metrics = summarizeLookback(makeInput(), 30);

    expect(metrics.totalInputTokens).toBe(300);
    expect(metrics.totalOutputTokens).toBe(150);
    expect(metrics.totalTokens).toBe(450);
    // Cost is summed from the per-day window (1.5 + 3), NOT the all-time
    // byModel spend (9) — a windowed token count must not carry a lifetime cost.
    expect(metrics.estimatedCostUsd).toBeCloseTo(4.5);
    expect(metrics.avgSessionDurationSec).toBe(120);
    expect(metrics.totalSkillInvocations).toBe(4);
  });

  it("uses the payload windowDays for lookbackDays", () => {
    const metrics = summarizeLookback(makeInput(), 1);

    // FEA-2345: lookbackDays now comes from the payload's windowDays (30),
    // not the caller's lookbackDays parameter.
    expect(metrics.lookbackDays).toBe(30);
    // Totals come from the payload directly, not re-sliced from byDay.
    expect(metrics.totalTokens).toBe(450);
    expect(metrics.estimatedCostUsd).toBeCloseTo(4.5);
  });

  it("reports null cost when byDay window is empty", () => {
    const metrics = summarizeLookback(makeInputWithTokens({ byDay: [] }));

    expect(metrics.totalTokens).toBe(450);
    expect(metrics.estimatedCostUsd).toBeNull();
  });

  it("omits cost when the window has token history but no per-day spend", () => {
    const metrics = summarizeLookback(
      makeInput({
        analytics: makeAnalyticsWithoutPerDayCost(),
      })
    );

    // A windowed token count with no windowable cost reports null rather than
    // overstating spend with the all-time total.
    expect(metrics.totalTokens).toBe(450);
    expect(metrics.estimatedCostUsd).toBeNull();
  });

  it("measures the share of shell commands not routed through rtk", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [
          shellEvent("git status"),
          shellEvent("git status"),
          shellEvent("rtk git status"),
          shellEvent("rtk pnpm build"),
        ],
      })
    );

    // 2 of 4 shell commands are unwrapped.
    expect(metrics.unwrappedShellCommandRatio).toBeCloseTo(0.5);
  });

  it("surfaces repeated command families above the threshold", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [
          shellEvent("gh pr view 1"),
          shellEvent("gh pr view 2"),
          shellEvent("gh pr view 3"),
          shellEvent("ls"),
        ],
      })
    );

    const family = metrics.repeatedCommandFamilies.find(
      (entry) => entry.family === "gh pr"
    );
    expect(family?.count).toBe(3);
    expect(metrics.repeatedCommandFamilies.some((e) => e.family === "ls")).toBe(
      false
    );
  });
});

describe("hasSubstantiveCoachingActivity", () => {
  it("is false when there is no session, event, token, or captured-event signal", () => {
    expect(hasSubstantiveCoachingActivity(makeEmptyInput())).toBe(false);
  });

  it("is true when the default fixture carries sessions and token spend", () => {
    expect(hasSubstantiveCoachingActivity(makeInput())).toBe(true);
  });

  it("is true when only a recent event is present (boundary)", () => {
    expect(
      hasSubstantiveCoachingActivity({
        ...makeEmptyInput(),
        recentEvents: [shellEvent("git status")],
      })
    ).toBe(true);
  });

  it("is true when only workflow session stats are present (boundary)", () => {
    expect(
      hasSubstantiveCoachingActivity({
        ...makeEmptyInput(),
        workflow: makeWorkflow(),
      })
    ).toBe(true);
  });
});

describe("groundedMetricsHaveActivity", () => {
  // The renderer's "wait for the corpus to populate" gate reads this on the
  // metrics a load already returned — it must agree with the generation gate on
  // the session/event/token signal and treat null (nothing computed) as "keep
  // waiting".
  it("is false for null metrics (nothing computed yet)", () => {
    expect(groundedMetricsHaveActivity(null)).toBe(false);
  });

  it("is false when the metrics have zero sessions, events, and tokens", () => {
    expect(
      groundedMetricsHaveActivity(summarizeLookback(makeEmptyInput()))
    ).toBe(false);
  });

  it("is true when the metrics reflect real sessions and token spend", () => {
    expect(groundedMetricsHaveActivity(summarizeLookback(makeInput()))).toBe(
      true
    );
  });
});

describe("computePeakFrustration (FEA-3399)", () => {
  it("picks the highest-scoring user turn and redacts its excerpt", () => {
    const peak = computePeakFrustration([
      userEvent("please just make it work"),
      errorEvent(),
      userEvent(
        "STOP. this is WRONG again, revert it please sk_live_deadbeefsecret!!"
      ),
      errorEvent(),
      userEvent("thanks, looks good"),
    ]);

    expect(peak).not.toBeNull();
    // Shouting + multiple frustration words + pleading punctuation + the two
    // adjacent error events push this turn above the quieter ones.
    expect(peak?.score).toBeGreaterThanOrEqual(2);
    expect(peak?.nearbyErrorCount).toBe(2);
    // No raw secret leaves the device.
    expect(peak?.excerpt).not.toContain("sk_live_deadbeefsecret");
    expect(peak?.excerpt).toContain("[REDACTED:sk_live]");
    expect(peak?.sessionName).toBe("Session");
  });

  it("returns null when no turn clears the confidence threshold (no forced crash-out)", () => {
    const peak = computePeakFrustration([
      userEvent("let's add a test for the parser"),
      userEvent("looks good, ship it"),
    ]);

    expect(peak).toBeNull();
  });

  it("ignores non-user events when scoring frustration", () => {
    const peak = computePeakFrustration([
      // An assistant/tool event with frustration-shaped text must not count.
      shellEvent("STOP WRONG again please!!"),
    ]);

    expect(peak).toBeNull();
  });
});

describe("summarizeLookback peakFrustration (FEA-3399)", () => {
  it("surfaces the peak-frustration signal in the grounded metrics", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [
          userEvent("STOP this is WRONG again, revert please!!"),
          errorEvent(),
        ],
      })
    );

    expect(metrics.peakFrustration).not.toBeNull();
    expect(metrics.peakFrustration?.score).toBeGreaterThanOrEqual(2);
  });

  it("reports null peakFrustration when there is no confident peak", () => {
    const metrics = summarizeLookback(makeInput({ recentEvents: [] }));
    expect(metrics.peakFrustration).toBeNull();
  });
});

// FEA-3397: Paxel fun-fact lookback signals.
describe("summarizeLookback fun-fact signals", () => {
  describe("modelMix", () => {
    it("derives token share per model, sorted favorite-first", () => {
      const metrics = summarizeLookback(makeInput());

      // The default fixture attributes all 450 tokens to one model.
      expect(metrics.modelMix).toEqual([
        {
          model: "claude-sonnet-4-5",
          tokens: 450,
          share: 1,
          sessions: 2,
        },
      ]);
    });

    it("ranks multiple models by share and sums input+output tokens", () => {
      const metrics = summarizeLookback(
        makeInputWithTokens({
          byModel: [
            {
              model: "claude-opus-4-8",
              inputTokens: 100,
              outputTokens: 100,
              sessions: 1,
            },
            {
              model: "claude-sonnet-4-6",
              inputTokens: 400,
              outputTokens: 400,
              sessions: 3,
            },
          ],
        })
      );

      expect(metrics.modelMix?.map((entry) => entry.model)).toEqual([
        "claude-sonnet-4-6",
        "claude-opus-4-8",
      ]);
      expect(metrics.modelMix?.[0]?.tokens).toBe(800);
      expect(metrics.modelMix?.[0]?.share).toBeCloseTo(0.8);
      expect(metrics.modelMix?.[1]?.share).toBeCloseTo(0.2);
    });

    it("is null when there is no per-model token attribution", () => {
      const metrics = summarizeLookback(makeInputWithTokens({ byModel: [] }));
      expect(metrics.modelMix).toBeNull();
    });
  });

  describe("planModeRatio", () => {
    it("is null (undetectable) when no plan-mode marker appears at all", () => {
      const metrics = summarizeLookback(
        makeInput({
          recentEvents: [shellEvent("git status"), shellEvent("ls")],
        })
      );
      // Never a false `false`: absence of markers reads as "undetectable".
      expect(metrics.planModeRatio).toBeNull();
    });

    it("measures the fraction of sessions that used plan mode", () => {
      const metrics = summarizeLookback(
        makeInput({
          recentEvents: [
            planEvent("session-a"),
            shellEvent("git status", "session-a"),
            shellEvent("ls", "session-b"),
          ],
        })
      );
      // 1 of 2 sessions (session-a) shows a plan marker.
      expect(metrics.planModeRatio).toBeCloseTo(0.5);
    });

    it("detects the Codex update_plan marker too", () => {
      const metrics = summarizeLookback(
        makeInput({
          recentEvents: [toolEvent("update_plan", "session-x")],
        })
      );
      expect(metrics.planModeRatio).toBeCloseTo(1);
    });
  });

  describe("topPrompts", () => {
    it("is null when no user-turn text is captured", () => {
      const metrics = summarizeLookback(
        makeInput({ recentEvents: [shellEvent("git status")] })
      );
      expect(metrics.topPrompts).toBeNull();
    });

    it("ranks normalized prompts and reports the average length", () => {
      const metrics = summarizeLookback(
        makeInput({
          recentEvents: [
            promptEvent("Fix the bug"),
            promptEvent("fix   the bug"),
            promptEvent("Write tests"),
          ],
        })
      );
      expect(metrics.topPrompts?.prompts[0]).toEqual({
        text: "Fix the bug",
        count: 2,
      });
      // (11 + 13 + 11) / 3 = 11.67 → 12.
      expect(metrics.topPrompts?.avgPromptChars).toBe(12);
    });

    it("redacts secrets before storing prompt text", () => {
      const metrics = summarizeLookback(
        makeInput({
          recentEvents: [promptEvent("deploy with sk_live_abc123def456ghi")],
        })
      );
      const text = metrics.topPrompts?.prompts[0]?.text ?? "";
      expect(text).toContain("[REDACTED:sk_live]");
      expect(text).not.toContain("sk_live_");
    });
  });

  describe("sessionCadence", () => {
    it("is null when no event carries a parseable timestamp", () => {
      const metrics = summarizeLookback(
        makeInput({ recentEvents: [timestampedEvent(null)] })
      );
      expect(metrics.sessionCadence).toBeNull();
    });

    it("buckets events by hour and weekday and flags a night owl", () => {
      const metrics = summarizeLookback(
        makeInput({
          recentEvents: [
            // 02:00 and 03:00 LOCAL time (construct from local components so
            // the histogram is timezone-independent).
            timestampedEvent(localIso(2026, 5, 15, 2)),
            timestampedEvent(localIso(2026, 5, 15, 3)),
            timestampedEvent(localIso(2026, 5, 15, 14)),
          ],
        })
      );
      expect(metrics.sessionCadence?.byHour[2]).toBe(1);
      expect(metrics.sessionCadence?.byHour[3]).toBe(1);
      expect(metrics.sessionCadence?.byHour[14]).toBe(1);
      // 2 of 3 events are before 6am → night owl.
      expect(metrics.sessionCadence?.nightOwlRatio).toBeCloseTo(2 / 3);
      expect(metrics.sessionCadence?.label).toContain("night owl");
    });
  });
});

describe("renderAgentCoachingPrompt", () => {
  it("surfaces the peak-frustration metric and resilience focus area (FEA-3399)", () => {
    const input = makeInput({
      recentEvents: [
        userEvent("STOP this is WRONG again, revert please!!"),
        errorEvent(),
      ],
    });
    const prompt = renderAgentCoachingPrompt(
      buildAgentCoachingLlmRequest(input, [])
    );

    expect(prompt).toContain("peak frustration");
    expect(prompt).toContain("resilience");
  });

  it("demands quantified claims and embeds the grounded metrics + exclusions", () => {
    const input = makeInput({
      feedback: [
        {
          action: "dismissed",
          category: "token_efficiency",
          createdAt: "2026-06-10T00:00:00.000Z",
          tipId: "old-tip",
        },
      ],
    });
    const request = buildAgentCoachingLlmRequest(input, []);
    const prompt = renderAgentCoachingPrompt(request);

    expect(prompt).toContain("QUANTIFIED");
    expect(prompt).toContain("rtk");
    expect(prompt).toContain("token_efficiency");
    expect(prompt).toContain("old-tip");
    expect(request.excludeTipIds).toEqual(["old-tip"]);
  });

  // FEA-3837: sessions/events/duration/skills are all-time totals, not windowed,
  // so the prompt must present them as lifetime figures — never inside the
  // windowed block that only the token/cost/model totals belong to.
  it("labels the all-time session/event/duration/skill totals as lifetime, not windowed", () => {
    const request = buildAgentCoachingLlmRequest(makeInput(), []);
    const prompt = renderAgentCoachingPrompt(request);
    const lines = prompt.split("\n");

    const windowHeaderIndex = lines.findIndex((line) =>
      line.startsWith("Windowed metrics (last ")
    );
    const lifetimeHeaderIndex = lines.findIndex((line) =>
      line.startsWith("Lifetime totals (")
    );
    expect(windowHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(lifetimeHeaderIndex).toBeGreaterThan(windowHeaderIndex);

    // The all-time metrics sit under the lifetime header, not the windowed
    // header, and are explicitly marked "all time".
    const sessionsIndex = lines.findIndex((line) =>
      line.includes("sessions analyzed (all time): 2")
    );
    const eventsIndex = lines.findIndex((line) =>
      line.includes("events analyzed (all time): 40")
    );
    const durationIndex = lines.findIndex((line) =>
      line.includes("avg session duration (all time): 120s")
    );
    const skillsIndex = lines.findIndex((line) =>
      line.includes("total skill invocations (all time): 4")
    );
    expect(sessionsIndex).toBeGreaterThan(lifetimeHeaderIndex);
    expect(eventsIndex).toBeGreaterThan(lifetimeHeaderIndex);
    expect(durationIndex).toBeGreaterThan(lifetimeHeaderIndex);
    expect(skillsIndex).toBeGreaterThan(lifetimeHeaderIndex);

    // They no longer appear as bare (windowed-looking) lookback bullets.
    expect(prompt).not.toContain("- sessions analyzed: ");
    expect(prompt).not.toContain("- events analyzed: ");
    expect(prompt).not.toContain("- avg session duration: ");
    expect(prompt).not.toContain("- total skill invocations: ");
  });

  // FEA-3837 (review follow-up): shell ratio, repeats, frustration, plan mode,
  // prompts, and cadence are derived from recentEvents — the latest ≤200
  // captured events (getEventFeed, no date cutoff), a recency-capped sample, NOT
  // a 7d/30d/90d window. They must sit under the recent-sample header, never the
  // windowed one, so the model can't frame them as within the selected range.
  it("frames the event-derived signals as a recent sample, not windowed metrics", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInput({
        recentEvents: [
          shellEvent("git status"),
          userEvent("STOP that is WRONG again please!!"),
        ],
      }),
      []
    );
    const prompt = renderAgentCoachingPrompt(request);
    const lines = prompt.split("\n");

    const windowHeaderIndex = lines.findIndex((line) =>
      line.startsWith("Windowed metrics (")
    );
    const sampleHeaderIndex = lines.findIndex((line) =>
      line.startsWith("Recent-activity sample (")
    );
    expect(sampleHeaderIndex).toBeGreaterThan(windowHeaderIndex);

    for (const bullet of [
      "- shell commands NOT routed through rtk:",
      "- repeated command families:",
      '- peak frustration ("biggest crash out"):',
      "- plan mode usage:",
      "- most common prompts:",
      "- session cadence:",
    ]) {
      const index = lines.findIndex((line) => line.startsWith(bullet));
      expect(index).toBeGreaterThan(sampleHeaderIndex);
    }
  });

  // FEA-3837 (review follow-up): when analytics is unavailable, eventsAnalyzed
  // falls back to the recency-capped event feed — a sample, not an all-time
  // count — so the prompt must NOT label it "all time".
  it("labels eventsAnalyzed as a recent sample when analytics is unavailable", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInput({
        analytics: null,
        recentEvents: [shellEvent("git status"), shellEvent("git push")],
      }),
      []
    );
    const prompt = renderAgentCoachingPrompt(request);

    expect(prompt).toContain(
      "- events analyzed (recent sample, not all-time): 2"
    );
    expect(prompt).not.toContain("events analyzed (all time)");
  });

  // FEA-3722 (review follow-up): an all-time ("All") load reports windowDays 0;
  // request construction must thread the selected range so the prompt renders
  // "all time", not the 30-day default framing all-time token totals as a month.
  it("renders the window label as all time when the selected range is null", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInputWithTokens({ windowDays: 0 }),
      [],
      undefined,
      null
    );
    const prompt = renderAgentCoachingPrompt(request);

    expect(request.groundedMetrics.lookbackDays).toBe(0);
    expect(prompt).toContain("Windowed metrics (all time)");
    // The windowed token totals are still present, just not framed as a month.
    expect(prompt).toContain("- tokens: 450");
    expect(prompt).not.toContain("last 30 days");
    expect(prompt).not.toContain("last 0 days");
  });

  it("lets a coaching pack's signals override the built-in defaults", () => {
    const input = makeInput();
    const packSignals = [
      "Cache efficiency is the biggest lever — keep the prefix stable.",
      "Read targeted spans, not whole files.",
    ];
    const request = buildAgentCoachingLlmRequest(input, [], packSignals);
    expect(request.bestPracticeSignals).toEqual(packSignals);

    const prompt = renderAgentCoachingPrompt(request);
    expect(prompt).toContain("Cache efficiency is the biggest lever");
    // The built-in agentic-development signals are replaced, not appended.
    expect(prompt).not.toContain("OpenCode");
  });

  it("falls back to the built-in defaults when pack signals are empty", () => {
    const request = buildAgentCoachingLlmRequest(makeInput(), [], []);
    expect(request.bestPracticeSignals.join(" ")).toContain("Claude Code");
  });
});

// ISS-7336 (review follow-up): the prompt's own token line is a reader-facing
// figure, because a generated batch REPLACES the seed tips and every tip must
// restate a quantified figure. The suite's other prompt assertions use the 450
// fixture total, which is ungrouped and therefore renders identically in every
// locale — so they stay green under a revert of the pin. These use totals large
// enough for the group separator to be observable.
describe("renderAgentCoachingPrompt under a non-US default locale (ISS-7336)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the prompt suite on a German-default machine", () => {
    useGermanDefaultLocale();
    // Guards the harness: if this stub stops biting, the assertions below pass
    // against the exact bug they exist to catch.
    expect((8_888_888).toLocaleString()).toBe("8.888.888");
    expect((8_888_888).toLocaleString("en-US")).toBe("8,888,888");
  });

  it("pins the windowed token figures to the canonical locale", () => {
    useGermanDefaultLocale();
    const request = buildAgentCoachingLlmRequest(makeGroupedTokenInput(), []);
    const prompt = renderAgentCoachingPrompt(request);

    expect(prompt).toContain(
      "- tokens: 8,888,888 (in 1,234,567, out 7,654,321)"
    );
    expect(prompt).not.toContain("8.888.888");
    expect(prompt).not.toContain("1.234.567");
    expect(prompt).not.toContain("7.654.321");
  });
});

describe("parseGeneratedTips", () => {
  it("extracts and validates tips from a fenced JSON response", () => {
    const raw = [
      "Here are your tips:",
      "```json",
      JSON.stringify([validTip(), { id: "bad" }]),
      "```",
    ].join("\n");

    const tips = parseGeneratedTips(raw);

    // The malformed second entry is dropped; the valid one survives.
    expect(tips).toHaveLength(1);
    expect(tips[0]?.id).toBe("llm-token-tip");
  });

  it("returns an empty array when there is no JSON array", () => {
    expect(parseGeneratedTips("sorry, no tips today")).toEqual([]);
  });

  // FEA-3687 #1: harden parse against blobby fields leaking into prose.
  it("drops a tip whose body carries a raw event-JSON blob", () => {
    const garbled = {
      ...validTip(),
      id: "garbled-tip",
      body: 'Promote {"session_id":"abc","tool_input":{"command":"cd x"}} to a skill.',
    };
    const tips = parseGeneratedTips(JSON.stringify([validTip(), garbled]));
    expect(tips).toHaveLength(1);
    expect(tips[0]?.id).toBe("llm-token-tip");
  });

  it("drops a tip whose why-copy carries a giant slugified identifier", () => {
    const garbled = {
      ...validTip(),
      id: "garbled-slug-tip",
      detail: {
        ...validTip().detail,
        whyThisRecommendation:
          "Promoting it to session-id-65950db3-bb90-4438-babe-tool-input-command-cd-skill saves tokens.",
      },
    };
    const tips = parseGeneratedTips(JSON.stringify([garbled]));
    expect(tips).toHaveLength(0);
  });

  it("keeps a JSON example inside proposedArtifact (not scanned as prose)", () => {
    const withArtifact = {
      ...validTip(),
      id: "artifact-tip",
      proposedArtifact:
        '---\nname: x\n---\nExample event: {"session_id":"abc","tool_input":{"command":"cd x"}}',
    };
    const tips = parseGeneratedTips(JSON.stringify([withArtifact]));
    expect(tips).toHaveLength(1);
    expect(tips[0]?.proposedArtifact).toContain("session_id");
  });

  // FEA-3687 #4: the recommendation apply `kind` round-trips through parse.
  it("parses a create-new-file / edit-existing action kind", () => {
    const tip = {
      ...validTip(),
      id: "kind-tip",
      actions: [
        {
          id: "apply-new",
          label: "Apply",
          mode: "confirm_then_apply",
          safety: "moderate",
          result: "Installs a new skill.",
          kind: "edit-existing",
        },
      ],
    };
    const tips = parseGeneratedTips(JSON.stringify([tip]));
    expect(tips[0]?.actions[0]?.kind).toBe("edit-existing");
  });

  it("drops an invalid action kind to undefined without dropping the tip", () => {
    const tip = {
      ...validTip(),
      id: "bad-kind-tip",
      actions: [
        {
          id: "apply-bad",
          label: "Apply",
          mode: "confirm_then_apply",
          safety: "moderate",
          result: "Installs.",
          kind: "delete-everything",
        },
      ],
    };
    const tips = parseGeneratedTips(JSON.stringify([tip]));
    expect(tips).toHaveLength(1);
    expect(tips[0]?.actions[0]?.kind).toBeUndefined();
  });
});

// An all-empty corpus: no analytics/workflow (so 0 sessions/events/tokens) and
// no captured recent events. Nothing to ground a quantified tip in.
function makeEmptyInput(): AgentCoachingInput {
  return {
    analytics: null,
    feedback: [],
    generatedAt: GENERATED_AT,
    recentEvents: [],
    skills: [],
    workflow: null,
  };
}

function validTip() {
  return {
    actions: [
      {
        id: "draft-skill",
        label: "Draft skill",
        mode: "draft",
        result: "Drafts a skill.",
        safety: "safe",
      },
    ],
    body: "Enabling RTK would save ~35% of token spend over the last 30 days.",
    category: "token_efficiency",
    detail: {
      autoApply: "Draft only until confirmed.",
      howToAct: ["Enable rtk"],
      whatThisMeans: "Wrap shell calls with rtk.",
      whyThisRecommendation: "Most shell calls are unwrapped.",
    },
    evidence: ["70% of shell commands are not routed through rtk"],
    experiment: "Enable rtk for a day and compare token spend.",
    id: "llm-token-tip",
    title: "Route shell commands through RTK",
    whyItMatters: "Cuts token spend.",
  };
}
