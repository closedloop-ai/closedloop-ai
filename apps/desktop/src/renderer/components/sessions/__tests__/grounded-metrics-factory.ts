import type { AgentCoachingGroundedMetrics } from "../agent-coaching-types";

export function makeGroundedMetrics(
  overrides?: Partial<AgentCoachingGroundedMetrics>
): AgentCoachingGroundedMetrics {
  return {
    lookbackDays: 30,
    sessionsAnalyzed: 0,
    eventsAnalyzed: 0,
    eventsAnalyzedIsAllTime: true,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    avgSessionDurationSec: null,
    unwrappedShellCommandRatio: null,
    shellCommandsSampled: 0,
    repeatedCommandFamilies: [],
    totalSkillInvocations: 0,
    peakFrustration: null,
    modelMix: null,
    planModeRatio: null,
    topPrompts: null,
    sessionCadence: null,
    ...overrides,
  };
}
