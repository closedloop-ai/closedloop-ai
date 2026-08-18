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
  type AgentComponentInvocationAnchor,
  AgentComponentInvocationAnchorKind,
} from "@repo/api/src/types/agent-component-invocation";
import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
  TokenEventCostPoint,
  TranscriptTurnIdentity,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { JsonValue } from "@repo/api/src/types/common";
import { computeTokenCost } from "@repo/cost/genai-cost";
import type {
  NormalizedMessage,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedTokenRecord,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/lib/sessions/agent-session-detail-projection";

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
    metadata: { messages, slashCommands: session.slashCommands },
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
    // FEA-4178: the DB-backed detail path feeds `tokenEvents` from the
    // `token_events` table, but a parsed transcript (the primary web trace
    // source) has none — so without this the collapsed sub-agent box never got a
    // cost. Derive per-event cost points from the parser's own `tokenSeries`
    // (priced via the shared genai-cost model), tagged with each sub-agent's
    // identity, so the transcript-backed trace attributes sub-agent cost the
    // same way the DB path does.
    tokenEvents: buildTokenEventCostPoints(session),
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
    ...(tool.providerToolUseId
      ? { providerToolUseId: tool.providerToolUseId }
      : {}),
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
    id: sub.id,
    externalAgentId: subagentExternalId(sub),
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

/** Resolve an invocation anchor to the projected trace row that owns it. */
export function resolveTranscriptInvocationAnchorRow(
  items: readonly TurnItem[],
  anchor: AgentComponentInvocationAnchor | null | undefined
): number | null {
  if (!anchor || anchor.kind === AgentComponentInvocationAnchorKind.Session) {
    return null;
  }
  for (const item of items) {
    if (!("_row" in item)) {
      continue;
    }
    if (
      "transcriptIdentity" in item &&
      transcriptIdentityMatchesInvocationAnchor(item.transcriptIdentity, anchor)
    ) {
      return item._row;
    }
    if (
      item.type === "tools" &&
      item.items.some((tool) =>
        transcriptIdentityMatchesInvocationAnchor(
          tool.transcriptIdentity,
          anchor
        )
      )
    ) {
      return item._row;
    }
  }
  return null;
}

/** Exact, id-first matching shared by trace rendering and row resolution. */
export function transcriptIdentityMatchesInvocationAnchor(
  identity: TranscriptTurnIdentity | null | undefined,
  anchor: AgentComponentInvocationAnchor | null | undefined
): boolean {
  if (!(identity && anchor)) {
    return false;
  }
  if (anchor.kind === AgentComponentInvocationAnchorKind.Event) {
    return (
      identity.eventId === anchor.eventId ||
      (Boolean(anchor.providerToolUseId) &&
        identity.providerToolUseId === anchor.providerToolUseId)
    );
  }
  if (anchor.kind === AgentComponentInvocationAnchorKind.Agent) {
    return (
      identity.agentId === anchor.agentId ||
      (Boolean(anchor.externalAgentId) &&
        identity.externalAgentId === anchor.externalAgentId)
    );
  }
  if (anchor.kind === AgentComponentInvocationAnchorKind.UserTurn) {
    return identity.userTurnId === anchor.userTurnId;
  }
  if (anchor.kind === AgentComponentInvocationAnchorKind.Timestamp) {
    return (
      identity.timestamp === anchor.timestamp &&
      identity.timestampOrdinal === anchor.ordinal
    );
  }
  return false;
}

/**
 * The projected agent's `externalAgentId`, SSOT so a sub-agent's cost points
 * (`buildTokenEventCostPoints`) carry the SAME identity the projection meters
 * ownership against (`attributeTokenEventCosts`). A drift here would leave every
 * transcript-backed sub-agent's cost ownerless and its label omitted.
 */
function subagentExternalId(sub: NormalizedSubagent): string {
  return sub.nativeSubagentId ?? sub.id;
}

/**
 * FEA-4178: price one parser `tokenSeries` record into a USD cost, or `null`
 * when it carries no priced spend (unknown model / no counts). Timestamped so
 * historical pricing applies, mirroring the DB-backed cost path.
 */
function tokenRecordCostUsd(record: NormalizedTokenRecord): number | null {
  const timestamp = Date.parse(record.timestamp);
  const result = computeTokenCost({
    model: record.model,
    inputTokens: record.input,
    outputTokens: record.output,
    cacheReadTokens: record.cacheRead,
    cacheWriteTokens: record.cacheWrite,
    timestamp: Number.isFinite(timestamp) ? new Date(timestamp) : undefined,
  });
  return result.costUsd;
}

/**
 * FEA-4178: derive the projection's `tokenEvents` from a parsed transcript. The
 * DB-backed detail/branch paths read priced `token_events` rows; a transcript
 * has only per-record token COUNTS, so price each `tokenSeries` record here via
 * the shared genai-cost model. Sub-agent records carry that sub-agent's identity
 * (`subagentExternalId`, matching its projected agent) so the collapsed box's
 * cost is metered by OWNERSHIP; the main session's records stay ownerless
 * (`agentExternalId: null`) and feed only the session-level cumulative column.
 * Unpriced records are dropped rather than counted as $0.
 */
function buildTokenEventCostPoints(
  session: NormalizedSession
): TokenEventCostPoint[] {
  const points: TokenEventCostPoint[] = [];
  const pushRecords = (
    records: readonly NormalizedTokenRecord[] | undefined,
    agentExternalId: string | null
  ): void => {
    for (const record of records ?? []) {
      const tMs = Date.parse(record.timestamp);
      if (!Number.isFinite(tMs)) {
        continue;
      }
      const costUsd = tokenRecordCostUsd(record);
      if (costUsd == null || costUsd === 0) {
        continue;
      }
      points.push({ tMs, costUsd, agentExternalId });
    }
  };

  pushRecords(session.tokenSeries, null);
  for (const sub of session.subagents ?? []) {
    pushRecords(sub.tokenSeries, subagentExternalId(sub));
  }
  return points;
}
