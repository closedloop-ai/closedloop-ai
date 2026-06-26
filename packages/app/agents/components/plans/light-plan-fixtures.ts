import type { LightPlan, LightPlanVersion } from "./light-plans-shell";
import {
  getLightPlanStatusLabel,
  LightPlanConfirmationState,
  resolveLightPlanConfirmationState,
} from "./light-plans-shell";

export function createLightPlanFixture(
  overrides: Partial<LightPlan> = {}
): LightPlan {
  const sourceStatus = overrides.sourceStatus ?? "pending";
  const confirmationState =
    overrides.confirmationState ??
    resolveLightPlanConfirmationState(sourceStatus, true);

  return {
    id: "plan-1",
    title: "Shared telemetry plan",
    source: "session-summary",
    harness: "codex",
    captureMethod: "plans-dir",
    sourceStatus,
    confirmationState,
    statusLabel:
      overrides.statusLabel ??
      getLightPlanStatusLabel(sourceStatus, confirmationState),
    latestContent:
      "# Plan\n\nRender this as plain text, not markdown or executable HTML.",
    versionCount: 2,
    filePath: "runs/session/plans/plan.md",
    sourceLogPath: "runs/session/transcript.jsonl",
    confidence: 0.84,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:10:00.000Z",
    ...overrides,
  };
}

export function createLightPlanVersionFixture(
  overrides: Partial<LightPlanVersion> = {}
): LightPlanVersion {
  return {
    id: "plan-version-1",
    versionNumber: 1,
    authorType: "agent",
    captureMethod: "tool-output",
    createdAt: "2026-06-10T12:05:00.000Z",
    contentMarkdown: "## Version\n\nStill plain text.",
    ...overrides,
  };
}

export const populatedLightPlanFixtures = [
  createLightPlanFixture(),
  createLightPlanFixture({
    id: "plan-2",
    title: "",
    sourceStatus: "confirmed",
    confirmationState: LightPlanConfirmationState.Confirmed,
    statusLabel: "confirmed",
    latestContent: "",
    versionCount: 0,
    confidence: Number.NaN,
    createdAt: "not-a-date",
  }),
];

export const populatedLightPlanVersionFixtures = [
  createLightPlanVersionFixture(),
  createLightPlanVersionFixture({
    id: "plan-version-2",
    versionNumber: 2,
    authorType: "human",
    captureMethod: "manual-edit",
    createdAt: null,
    contentMarkdown: "",
  }),
];
