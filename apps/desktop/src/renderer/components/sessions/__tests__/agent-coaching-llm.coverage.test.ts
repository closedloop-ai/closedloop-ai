import { describe, expect, it } from "vitest";
import {
  buildAgentCoachingLlmRequest,
  renderAgentCoachingPrompt,
} from "../agent-coaching-llm";
import type {
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
  AgentCoachingLlmRequest,
} from "../agent-coaching-types";

const BASE_METRICS: AgentCoachingGroundedMetrics = {
  avgSessionDurationSec: null,
  estimatedCostUsd: null,
  eventsAnalyzed: 0,
  eventsAnalyzedIsAllTime: true,
  lookbackDays: 30,
  modelMix: null,
  peakFrustration: null,
  planModeRatio: null,
  repeatedCommandFamilies: [],
  sessionCadence: null,
  sessionsAnalyzed: 0,
  shellCommandsSampled: 0,
  topPrompts: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalSkillInvocations: null,
  totalTokens: 0,
  unwrappedShellCommandRatio: null,
};

function makeRequest(
  overrides: Partial<AgentCoachingLlmRequest> = {}
): AgentCoachingLlmRequest {
  return {
    allowedCategories: ["cost"],
    bestPracticeSignals: ["Signal one."],
    categoryLeverContract: [["cost", "cost"]],
    excludeTipIds: [],
    generationMode: "non_deterministic_high_reasoning",
    groundedMetrics: BASE_METRICS,
    localEvidence: {
      analytics: null,
      recentEvents: [],
      skills: [],
      workflow: null,
    },
    maxTips: 5,
    priorFeedback: [],
    reasoningEffort: "high",
    seedTips: [],
    temperature: 0.8,
    ...overrides,
  };
}

describe("renderAgentCoachingPrompt metric-block null branches", () => {
  it("renders 'unknown' for cost, plan mode ratio, and skill invocations when absent", () => {
    const prompt = renderAgentCoachingPrompt(makeRequest());

    expect(prompt).toContain("- estimated cost: unknown");
    expect(prompt).toContain("- plan mode usage: unknown");
    expect(prompt).toContain("- total skill invocations (all time): unknown");
  });

  it("renders concrete values for cost, plan mode ratio, and skill invocations when present", () => {
    const prompt = renderAgentCoachingPrompt(
      makeRequest({
        groundedMetrics: {
          ...BASE_METRICS,
          estimatedCostUsd: 12.5,
          planModeRatio: 0.4,
          totalSkillInvocations: 7,
        },
      })
    );

    expect(prompt).toContain("- estimated cost: $12.50");
    expect(prompt).toContain("- plan mode usage: 40% of sessions");
    expect(prompt).toContain("- total skill invocations (all time): 7");
  });

  it("falls back to '(no recent session activity captured yet)' with no events", () => {
    const prompt = renderAgentCoachingPrompt(makeRequest());

    expect(prompt).toContain("- (no recent session activity captured yet)");
  });

  it("prefers event.summary over event.data for the log excerpt text", () => {
    const prompt = renderAgentCoachingPrompt(
      makeRequest({
        localEvidence: {
          analytics: null,
          recentEvents: [
            {
              agentId: null,
              createdAt: "2026-06-17T00:00:00.000Z",
              data: "data-fallback-text",
              eventType: "tool_use",
              id: "event-1",
              sessionId: "session-1",
              sessionName: "My session",
              summary: "summary-text",
              toolName: "Bash",
            },
          ],
          skills: [],
          workflow: null,
        },
      })
    );

    expect(prompt).toContain("summary-text");
    expect(prompt).not.toContain("data-fallback-text");
  });

  it("falls back to event.data, then to an empty excerpt, when summary is absent", () => {
    const promptWithData = renderAgentCoachingPrompt(
      makeRequest({
        localEvidence: {
          analytics: null,
          recentEvents: [
            {
              agentId: null,
              createdAt: "2026-06-17T00:00:00.000Z",
              data: "data-only-text",
              eventType: "tool_use",
              id: "event-2",
              sessionId: "session-1",
              sessionName: null,
              summary: null,
              toolName: "Bash",
            },
          ],
          skills: [],
          workflow: null,
        },
      })
    );
    expect(promptWithData).toContain("data-only-text");

    const promptWithNeither = renderAgentCoachingPrompt(
      makeRequest({
        localEvidence: {
          analytics: null,
          recentEvents: [
            {
              agentId: null,
              createdAt: "2026-06-17T00:00:00.000Z",
              data: null,
              eventType: "tool_use",
              id: "event-3",
              sessionId: "session-1",
              sessionName: null,
              summary: null,
              toolName: "Bash",
            },
          ],
          skills: [],
          workflow: null,
        },
      })
    );
    // No summary, no data: the excerpt line still renders with an empty claim
    // (pins current behavior; looks odd because the label/tool prefix still
    // renders even with no text content to report).
    expect(promptWithNeither).toContain("[session] Bash: ");
  });
});

describe("renderCategoryLeverContract", () => {
  it("renders the no-warranted-lever branch when allowedCategories is empty", () => {
    const prompt = renderAgentCoachingPrompt(
      makeRequest({ allowedCategories: [] })
    );

    expect(prompt).toContain(
      "The user's current usage warrants NO coaching lever"
    );
    expect(prompt).toContain("For reference, each category pulls this lever");
  });

  it("renders the warranted-categories branch when allowedCategories is non-empty", () => {
    const prompt = renderAgentCoachingPrompt(
      makeRequest({ allowedCategories: ["cost"] })
    );

    expect(prompt).toContain("Produce tips ONLY in these categories");
    expect(prompt).not.toContain(
      "The user's current usage warrants NO coaching lever"
    );
  });
});

describe("buildAgentCoachingLlmRequest redaction of event evidence", () => {
  function makeInput(
    recentEvents: AgentCoachingInput["recentEvents"]
  ): AgentCoachingInput {
    return {
      analytics: null,
      feedback: [],
      generatedAt: new Date("2026-06-17T00:00:00.000Z"),
      recentEvents,
      skills: [],
      workflow: null,
    };
  }

  it("passes through summary/data/sessionName/toolName untouched when falsy", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInput([
        {
          agentId: null,
          createdAt: "2026-06-17T00:00:00.000Z",
          data: null,
          eventType: "tool_use",
          id: "event-1",
          sessionId: "session-1",
          sessionName: null,
          summary: null,
          toolName: null,
        },
      ]),
      []
    );

    const event = request.localEvidence.recentEvents[0];
    expect(event.summary).toBeNull();
    expect(event.data).toBeNull();
    expect(event.sessionName).toBeNull();
    expect(event.toolName).toBeNull();
  });

  it("redacts summary/data/sessionName/toolName when present", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInput([
        {
          agentId: null,
          createdAt: "2026-06-17T00:00:00.000Z",
          data: "sk_live_DEADBEEF1234",
          eventType: "tool_use",
          id: "event-1",
          sessionId: "session-1",
          sessionName: "sk_live_DEADBEEF1234",
          summary: "sk_live_DEADBEEF1234",
          toolName: "sk_live_DEADBEEF1234",
        },
      ]),
      []
    );

    const event = request.localEvidence.recentEvents[0];
    expect(event.summary).toContain("[REDACTED:sk_live]");
    expect(event.data).toContain("[REDACTED:sk_live]");
    expect(event.sessionName).toContain("[REDACTED:sk_live]");
    expect(event.toolName).toContain("[REDACTED:sk_live]");
  });

  it("falls back to AGENTIC_DEVELOPMENT_SIGNALS when bestPracticeSignals is empty", () => {
    const request = buildAgentCoachingLlmRequest(makeInput([]), [], []);

    expect(request.bestPracticeSignals.join(" ")).toContain("Claude Code");
  });

  it("uses the given non-empty bestPracticeSignals as-is", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInput([]),
      [],
      ["Custom signal."]
    );

    expect(request.bestPracticeSignals).toEqual(["Custom signal."]);
  });
});
