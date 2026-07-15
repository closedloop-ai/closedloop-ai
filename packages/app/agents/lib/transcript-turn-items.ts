/**
 * FEA-2717 (PLN-1290): the browser display adapter that maps a parsed
 * `NormalizedSession` (from `@repo/lib/harness`) into the `TurnItem[]` view model
 * that `SessionTrace` renders.
 *
 * Crucially it does NOT reimplement trace assembly: it reshapes the parser's flat
 * arrays into the shared projection's input contract (`metadata.messages`,
 * `events`, `agents`) and hands off to `projectAgentSessionTurnItems` — the SAME
 * projection the desktop DB-backed detail path runs. So the cloud-rendered trace
 * and the DB-backed trace agree by construction (PLN-1290's "one parser, zero
 * interpretation divergence" thesis). All ordering / tool-run coalescing / label
 * logic lives in the one shared projection; this file only owns the
 * parser-output → projection-input mapping.
 */
import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/api/src/agent-session-detail-projection";
import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { JsonValue } from "@repo/api/src/types/common";
import type {
  NormalizedMessage,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "@repo/lib/harness/types";

/** Display identity for the human/agent actors of the projected trace. */
export type TranscriptActorContext = {
  /** Session harness (`claude`/`codex`/…) — set on the agent actor for badges. */
  harness: string;
  /** Primary model id, rendered as the agent actor name. */
  primaryModel: string | null;
  /** Human author display name + swatch color (from the session detail row). */
  humanActor: { name: string | null; color: string };
};

/** The projection assigns this to any event/subagent that carries no timestamp. */
const FALLBACK_EVENT_TIME = new Date(0).toISOString();

/**
 * Metadata message shape the shared projection consumes. Structurally identical
 * to `NormalizedMessage` minus the DB-import-only fields (`tokens`,
 * `isSynthetic`), with a required (non-null) timestamp.
 */
type ProjectionMetadataMessage = {
  role: NormalizedMessage["role"];
  timestamp: string;
  text: string | null;
  model?: string | null;
  isThinking?: boolean;
};

/**
 * Map a parsed `NormalizedSession` to the shared trace `TurnItem[]`.
 *
 * The mapping is deliberately thin — reshape the parser's flat arrays into the
 * projection's input contract, then delegate to `projectAgentSessionTurnItems`.
 */
export function buildTurnItemsFromNormalizedSession(
  session: NormalizedSession,
  context: TranscriptActorContext
): TurnItem[] {
  // `session.toolUses` is the COMPLETE tool set — subagent tools are pushed here
  // too, tagged with `subagentId` (parse-claude.ts). Building events only from
  // this array (never also from `subagents[].toolUses`) is what keeps the trace
  // from double-counting; `agentExternalId` re-links each subagent tool to its
  // owner so the projection folds it into the subagent body.
  const events = session.toolUses.map(toolUseToEvent);
  const agents = (session.subagents ?? []).map(subagentToAgent);
  const messages = session.messages
    .filter(hasTimestamp)
    .map(toProjectionMetadataMessage);
  const tokenUsageByModel = tokensByModelToUsage(session.tokensByModel);

  const timeline = projectAgentSessionTimelineEvents(events, {
    metadata: { messages },
  });

  return projectAgentSessionTurnItems({
    sessionId: session.sessionId,
    harness: context.harness,
    primaryModel: context.primaryModel,
    humanActor: context.humanActor,
    timeline,
    agents,
    events,
    tokenUsageByModel,
  });
}

function hasTimestamp(
  message: NormalizedMessage
): message is NormalizedMessage & { timestamp: string } {
  return typeof message.timestamp === "string" && message.timestamp.length > 0;
}

function toProjectionMetadataMessage(
  message: NormalizedMessage & { timestamp: string }
): ProjectionMetadataMessage {
  return {
    role: message.role,
    timestamp: message.timestamp,
    text: message.text,
    model: message.model ?? null,
    isThinking: message.isThinking,
  };
}

function toolUseToEvent(
  tool: NormalizedToolUse,
  index: number
): SyncedAgentSessionEvent {
  const data: { [key: string]: JsonValue } = {};
  if (tool.input !== undefined) {
    data.tool_input = asJsonValue(tool.input);
  }
  if (tool.output !== undefined) {
    data.tool_response = asJsonValue(tool.output);
  }
  if (tool.mcpServer) {
    data.mcpServer = tool.mcpServer;
  }
  if (tool.mcpMethod) {
    data.mcpMethod = tool.mcpMethod;
  }
  if (tool.skillName) {
    data.skillName = tool.skillName;
  }
  if (tool.diffDelta) {
    data.diffDelta = { add: tool.diffDelta.add, del: tool.diffDelta.del };
  }
  return {
    externalEventId: tool.id ?? `tool-${index}`,
    agentExternalId: tool.subagentId ?? null,
    // An `error` substring in the type is how the projection flags a failed row
    // (red dot / tools-card `err`). The kind stays "tool" because `toolName` is
    // set, so the flag rides along without changing the row category.
    eventType: tool.isError ? "PostToolUseError" : "PostToolUse",
    toolName: tool.name,
    summary: null,
    data,
    createdAt: tool.timestamp ?? FALLBACK_EVENT_TIME,
  };
}

function subagentToAgent(sub: NormalizedSubagent): SyncedAgentSessionAgent {
  return {
    externalAgentId: sub.id,
    name: sub.name,
    // Either field satisfies the projection's `isSubagent` check; set both so a
    // parser that omits `type` still projects as a subagent turn.
    type: sub.type ?? "subagent",
    subagentType: sub.type ?? null,
    status: sub.status ?? "unknown",
    task: sub.task ?? null,
    currentTool: null,
    startedAt: sub.startedAt ?? null,
    updatedAt: sub.endedAt ?? sub.startedAt ?? null,
    endedAt: sub.endedAt ?? null,
    parentExternalAgentId: sub.parentId ?? null,
    metadata: null,
  };
}

function tokensByModelToUsage(
  byModel: NormalizedSession["tokensByModel"]
): SyncedAgentSessionTokenUsage[] {
  return Object.entries(byModel).map(([model, counts]) => ({
    model,
    inputTokens: counts.input,
    outputTokens: counts.output,
    cacheReadTokens: counts.cacheRead,
    cacheWriteTokens: counts.cacheWrite,
  }));
}

/**
 * Narrow an arbitrary parsed value (tool input/output originating from
 * `JSON.parse`) to the `JsonValue` the projection's `data` field expects.
 * `undefined`/functions/symbols collapse to `null` — the projection reads `data`
 * defensively, so a lossy field never crashes the trace.
 */
function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = asJsonValue(entry);
    }
    return out;
  }
  return null;
}
