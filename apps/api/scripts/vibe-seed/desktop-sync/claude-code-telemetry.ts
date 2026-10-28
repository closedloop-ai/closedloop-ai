import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import {
  ClaudeCodeTelemetryDropReason,
  DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST,
  DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
  type DesktopClaudeCodeComponentTelemetryInput,
  type DesktopClaudeCodeSessionTelemetryInput,
  desktopClaudeCodeTelemetrySyncRequestSchema,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { withDb } from "@repo/database";
import { desktopClaudeCodeTelemetrySyncService } from "@/app/desktop/claude-code-telemetry/sync/service";
import type { VibeSeedContext } from "../stage";
import {
  type DesktopSyncTarget,
  resolveDesktopSyncTargets,
} from "./sync-target";

/**
 * ISS-12017: fill the Claude Code OTel telemetry lane through
 * `desktopClaudeCodeTelemetrySyncService`, the service behind `POST
 * /desktop/claude-code-telemetry/sync`.
 *
 * The golden corpus carries no OTel export (its `claude_code_*` tables are
 * empty), so each Claude session's delivery is built from what the cloud
 * already holds for it: the usage rollup the golden ingest wrote (turns, tool
 * calls, errors, cost), its component usage, and the line counts the
 * invocation lane just delivered. Families with no such source are omitted,
 * which the contract reads as "never recorded", not as zero.
 */

export const CLAUDE_CODE_TELEMETRY_STAGE = "claude-code-telemetry";

/**
 * Per-turn and per-prompt active seconds. OTel `active_time.total` counts CLI
 * work and keyboard time, not wall clock, so a multi-day session must not read
 * as days of activity; both are capped by the session's runtime.
 */
const CLI_SECONDS_PER_AGENT_TURN = 9.5;
const USER_SECONDS_PER_HUMAN_TURN = 38;
const USD_DECIMALS = 6;
const SECONDS_DECIMALS = 3;
const MCP_TOOL_SEPARATOR = "__";

/** Desktop's `ClaudeCodeActivityType` (`claude-code-otel-signal-contract.ts`). */
const ActivityType = { User: "user", Cli: "cli" } as const;
/** The `type` attribute of `claude_code.lines_of_code.count`. */
const LinesChangeType = { Added: "added", Removed: "removed" } as const;
/** Desktop's `ClaudeCodeAttributionSource` (`claude-code-otel-attribution.ts`). */
const HARNESS_OTEL_ATTRIBUTION = "harness_otel";

export type TelemetrySession = Awaited<
  ReturnType<typeof readClaudeSessions>
>[number];

export async function syncClaudeCodeTelemetry(
  context: VibeSeedContext
): Promise<void> {
  let delivered = 0;
  for (const target of await resolveDesktopSyncTargets(
    context,
    CLAUDE_CODE_TELEMETRY_STAGE
  )) {
    const sessions = await readClaudeSessions(target);
    for (const [index, session] of sessions.entries()) {
      const lines = await readLinesByModel(session.artifactId);
      await deliver(target, {
        protocolVersion: DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
        session: buildSessionTelemetry(session, lines),
        dropCounters: index === 0 ? dropCounters(sessions) : [],
      });
    }
    delivered += sessions.length;
  }
  if (delivered === 0) {
    throw new Error(
      "no ingested Claude session with a usage rollup to report telemetry for"
    );
  }
  context.log(`delivered Claude Code telemetry for ${delivered} session(s)`);
}

async function deliver(
  target: DesktopSyncTarget,
  body: Record<string, unknown>
): Promise<void> {
  const parsed = desktopClaudeCodeTelemetrySyncRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Claude Code telemetry payload fails the lane schema: ${parsed.error.message}`
    );
  }
  const result = await desktopClaudeCodeTelemetrySyncService.sync({
    clerkUserId: target.clerkUserId,
    computeTargetId: target.computeTargetId,
    organizationId: target.organizationId,
    rawBody: body,
    userId: target.userId,
  });
  if (!result.ok) {
    throw new Error(
      `Claude Code telemetry sync refused: ${String(result.error.reason)}`
    );
  }
  if (!result.value.accepted) {
    throw new Error(
      `Claude Code telemetry sync rejected ${String(result.value.externalSessionId)}: ${String(result.value.reason)}`
    );
  }
}

export function buildSessionTelemetry(
  session: TelemetrySession,
  lines: readonly LinesByModel[]
): DesktopClaudeCodeSessionTelemetryInput {
  const rollup = session.usageRollup;
  if (rollup === null) {
    throw new Error(`session ${session.externalSessionId} has no usage rollup`);
  }
  const cost = Number(rollup.estimatedCost);
  const runtimeSeconds = Number(rollup.runtimeMs ?? 0n) / 1000;
  const components = toComponents(session, cost);
  return {
    externalSessionId: session.externalSessionId,
    harness: session.harness,
    costEventCount: rollup.agentTurns,
    apiRequestCount: rollup.agentTurns,
    errorEventCount: rollup.errorEvents,
    toolResultCount: rollup.toolInvocations,
    sessionStartCount: 1,
    costEventUsd: cost.toFixed(USD_DECIMALS),
    observedFrom: session.sessionStartedAt.toISOString(),
    observedTo: session.lastActivityAt.toISOString(),
    components: components.slice(
      0,
      DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST
    ),
    componentsTruncated:
      components.length >
      DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST,
    activeTime: [
      {
        activityType: ActivityType.Cli,
        seconds: Math.min(
          runtimeSeconds,
          rollup.agentTurns * CLI_SECONDS_PER_AGENT_TURN
        ).toFixed(SECONDS_DECIMALS),
      },
      {
        activityType: ActivityType.User,
        seconds: Math.min(
          runtimeSeconds,
          rollup.humanTurns * USER_SECONDS_PER_HUMAN_TURN
        ).toFixed(SECONDS_DECIMALS),
      },
    ],
    activeTimeTruncated: false,
    linesOfCode: linesForSession(session, lines),
    linesOfCodeTruncated: false,
  };
}

/**
 * Invocations without a model of their own (the main agent's tool calls) ran
 * on the session's model, so they fold into that model's row.
 */
function linesForSession(
  session: TelemetrySession,
  lines: readonly LinesByModel[]
) {
  const byModel = new Map<string, { added: number; removed: number }>();
  for (const row of lines) {
    const model = row.model ?? session.model ?? "";
    const total = byModel.get(model) ?? { added: 0, removed: 0 };
    byModel.set(model, {
      added: total.added + row.added,
      removed: total.removed + row.removed,
    });
  }
  return [...byModel.entries()].flatMap(([model, total]) => [
    {
      model,
      changeType: LinesChangeType.Added,
      lineCount: String(total.added),
    },
    {
      model,
      changeType: LinesChangeType.Removed,
      lineCount: String(total.removed),
    },
  ]);
}

/**
 * One OTel attribution per skill, subagent, and MCP tool the session used,
 * with the session's cost apportioned by invocation share.
 */
function toComponents(
  session: TelemetrySession,
  cost: number
): DesktopClaudeCodeComponentTelemetryInput[] {
  const attributed = session.componentUsages.flatMap((usage) => {
    const names = attributionNames(usage.componentKind, usage.componentKey);
    return names === null
      ? []
      : [{ names, invocations: usage.invocationCount }];
  });
  const total = attributed.reduce((sum, row) => sum + row.invocations, 0);
  return attributed
    .sort(
      (a, b) =>
        b.invocations - a.invocations ||
        attributionKeyOf(a.names).localeCompare(attributionKeyOf(b.names))
    )
    .map((row) => ({
      ...row.names,
      attributionKey: attributionKeyOf(row.names),
      attributionSource: HARNESS_OTEL_ATTRIBUTION,
      costEventCount: row.invocations,
      costUsd: (total === 0 ? 0 : (cost * row.invocations) / total).toFixed(
        USD_DECIMALS
      ),
    }));
}

type AttributionNames = {
  agentName?: string;
  skillName?: string;
  pluginName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
};

function attributionNames(kind: string, key: string): AttributionNames | null {
  if (kind === AgentComponentKind.Subagent) {
    return { agentName: key };
  }
  if (kind === AgentComponentKind.Skill) {
    const [plugin, skill] = key.split(":");
    return skill === undefined
      ? { skillName: key }
      : { pluginName: plugin, skillName: skill };
  }
  if (kind === AgentComponentKind.Mcp) {
    const [, server, ...tool] = key.split(MCP_TOOL_SEPARATOR);
    return server === undefined || tool.length === 0
      ? null
      : { mcpServerName: server, mcpToolName: tool.join(MCP_TOOL_SEPARATOR) };
  }
  return null;
}

/**
 * Desktop's `attributionKeyOf` (`claude-code-otel-attribution.ts`): each
 * identity field, in its fixed order, length-prefixed so no two attributions
 * collide. The app cannot import Desktop's module, so the encoding is restated.
 */
function attributionKeyOf(names: AttributionNames): string {
  return [
    names.agentName,
    names.skillName,
    names.pluginName,
    undefined,
    names.mcpServerName,
    names.mcpToolName,
    undefined,
  ]
    .map((part) => part ?? "")
    .map((part) => `${part.length}:${part}`)
    .join("");
}

/**
 * One machine-level receiver-backpressure counter spanning the sessions, so
 * the session screen's completeness signal has a recorded loss to report.
 */
function dropCounters(sessions: readonly TelemetrySession[]) {
  const starts = sessions.map((session) => session.sessionStartedAt.getTime());
  const ends = sessions.map((session) => session.lastActivityAt.getTime());
  return [
    {
      harness: Harness.Claude,
      reason: ClaudeCodeTelemetryDropReason.ReceiverBackpressure,
      droppedCount: String(sessions.length),
      firstObservedAt: new Date(Math.min(...starts)).toISOString(),
      lastObservedAt: new Date(Math.max(...ends)).toISOString(),
    },
  ];
}

function readClaudeSessions(target: DesktopSyncTarget) {
  return withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        computeTargetId: target.computeTargetId,
        harness: Harness.Claude,
        artifact: { organizationId: target.organizationId },
        usageRollup: { isNot: null },
      },
      orderBy: { externalSessionId: "asc" },
      select: {
        artifactId: true,
        externalSessionId: true,
        harness: true,
        model: true,
        sessionStartedAt: true,
        lastActivityAt: true,
        usageRollup: {
          select: {
            agentTurns: true,
            humanTurns: true,
            toolInvocations: true,
            errorEvents: true,
            estimatedCost: true,
            runtimeMs: true,
          },
        },
        componentUsages: {
          where: {
            componentKind: {
              in: [
                AgentComponentKind.Skill,
                AgentComponentKind.Subagent,
                AgentComponentKind.Mcp,
              ],
            },
          },
          select: {
            componentKind: true,
            componentKey: true,
            invocationCount: true,
          },
        },
      },
    })
  );
}

export type LinesByModel = {
  model: string | null;
  added: number;
  removed: number;
};

/** Lines changed per model in the session's active invocation generation. */
async function readLinesByModel(artifactId: string): Promise<LinesByModel[]> {
  const rows = await withDb((db) =>
    db.agentComponentInvocation.groupBy({
      by: ["model"],
      where: {
        generation: { agentSessionId: artifactId, activeAt: { not: null } },
        linesAdded: { not: null },
      },
      _sum: { linesAdded: true, linesRemoved: true },
      orderBy: { model: "asc" },
    })
  );
  return rows.map((row) => ({
    model: row.model,
    added: row._sum.linesAdded ?? 0,
    removed: row._sum.linesRemoved ?? 0,
  }));
}
