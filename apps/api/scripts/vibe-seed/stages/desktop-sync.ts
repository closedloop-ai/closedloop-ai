import {
  CLAUDE_CODE_TELEMETRY_STAGE,
  syncClaudeCodeTelemetry,
} from "../desktop-sync/claude-code-telemetry";
import {
  DESKTOP_COMPONENTS_STAGE,
  syncGoldenComponents,
} from "../desktop-sync/components";
import {
  DESKTOP_INVOCATIONS_STAGE,
  syncGoldenInvocations,
} from "../desktop-sync/invocations";
import {
  SESSION_MESH_STAGE,
  seedSessionMesh,
} from "../desktop-sync/session-mesh";
import {
  DESKTOP_TRANSCRIPTS_STAGE,
  syncGoldenTranscripts,
} from "../desktop-sync/transcripts";
import type { VibeSeedStage } from "../stage";

export const STAGES: readonly VibeSeedStage[] = [
  {
    name: DESKTOP_COMPONENTS_STAGE,
    models: ["AgentComponent", "AgentComponentVersion"],
    run: syncGoldenComponents,
  },
  {
    name: DESKTOP_INVOCATIONS_STAGE,
    models: ["AgentComponentInvocation"],
    run: syncGoldenInvocations,
  },
  {
    name: CLAUDE_CODE_TELEMETRY_STAGE,
    models: [
      "ClaudeCodeSessionTelemetry",
      "ClaudeCodeComponentTelemetry",
      "ClaudeCodeActiveTimeTelemetry",
      "ClaudeCodeLinesOfCodeTelemetry",
      "ClaudeCodeSignalDropCounter",
    ],
    run: syncClaudeCodeTelemetry,
  },
  {
    name: SESSION_MESH_STAGE,
    models: [
      "SessionMeshPresence",
      "SessionMeshMessage",
      "SessionMeshDelivery",
      "SessionMeshMetricEvent",
    ],
    run: seedSessionMesh,
  },
  {
    name: DESKTOP_TRANSCRIPTS_STAGE,
    models: ["SessionTranscript"],
    run: syncGoldenTranscripts,
  },
];
