/**
 * ISS-12017: the Claude Code telemetry delivery the vibe seed builds for one
 * ingested session, checked against the lane's own request schema and the
 * values Desktop's OTel rollup would report for the same components.
 */
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { desktopClaudeCodeTelemetrySyncRequestSchema } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  buildSessionTelemetry,
  type TelemetrySession,
} from "../vibe-seed/desktop-sync/claude-code-telemetry";

const SESSION_MODEL = "claude-opus-4-8";

const SESSION: TelemetrySession = {
  artifactId: "0192f0a0-0000-7000-8000-0000000000d1",
  externalSessionId: "c8a3eb17-b0f5-484e-b007-a45a230dbad7",
  harness: Harness.Claude,
  model: SESSION_MODEL,
  sessionStartedAt: new Date("2026-09-24T05:08:56.567Z"),
  lastActivityAt: new Date("2026-09-24T12:38:35.870Z"),
  usageRollup: {
    agentTurns: 4,
    humanTurns: 2,
    toolInvocations: 9,
    errorEvents: 1,
    estimatedCost: new Prisma.Decimal("3.000000"),
    runtimeMs: 60_000n,
  },
  componentUsages: [
    {
      componentKind: AgentComponentKind.Skill,
      componentKey: "code-review:present-local",
      invocationCount: 1,
    },
    {
      componentKind: AgentComponentKind.Subagent,
      componentKey: "explorer",
      invocationCount: 2,
    },
    {
      componentKind: AgentComponentKind.Command,
      componentKey: "/build",
      invocationCount: 5,
    },
  ],
};

describe("buildSessionTelemetry", () => {
  it("builds a delivery the lane schema accepts, with counts from the usage rollup", () => {
    const session = buildSessionTelemetry(SESSION, []);

    const parsed = desktopClaudeCodeTelemetrySyncRequestSchema.safeParse({
      session,
    });
    expect(parsed.success).toBe(true);
    expect(session).toMatchObject({
      costEventCount: 4,
      apiRequestCount: 4,
      errorEventCount: 1,
      toolResultCount: 9,
      costEventUsd: "3.000000",
    });
  });

  it("encodes attribution keys the way Desktop's attributionKeyOf does and splits cost by invocation share", () => {
    const { components } = buildSessionTelemetry(SESSION, []);

    expect(components).toStrictEqual([
      {
        agentName: "explorer",
        attributionKey: "8:explorer0:0:0:0:0:0:",
        attributionSource: "harness_otel",
        costEventCount: 2,
        costUsd: "2.000000",
      },
      {
        pluginName: "code-review",
        skillName: "present-local",
        attributionKey: "0:13:present-local11:code-review0:0:0:0:",
        attributionSource: "harness_otel",
        costEventCount: 1,
        costUsd: "1.000000",
      },
    ]);
  });

  it("caps active time at the session's runtime", () => {
    const { activeTime } = buildSessionTelemetry(SESSION, []);

    expect(activeTime).toStrictEqual([
      { activityType: "cli", seconds: "38.000" },
      { activityType: "user", seconds: "60.000" },
    ]);
  });

  it("folds model-less invocation lines into the session model's row", () => {
    const { linesOfCode } = buildSessionTelemetry(SESSION, [
      { model: null, added: 10, removed: 2 },
      { model: SESSION_MODEL, added: 5, removed: 1 },
      { model: "claude-haiku-4-5", added: 3, removed: 0 },
    ]);

    expect(linesOfCode).toStrictEqual([
      { model: SESSION_MODEL, changeType: "added", lineCount: "15" },
      { model: SESSION_MODEL, changeType: "removed", lineCount: "3" },
      { model: "claude-haiku-4-5", changeType: "added", lineCount: "3" },
      { model: "claude-haiku-4-5", changeType: "removed", lineCount: "0" },
    ]);
  });
});
