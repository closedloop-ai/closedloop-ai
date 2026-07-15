import type {
  AgentSessionState,
  SessionTimelineEvent,
  SubagentBodyLine,
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
  TokenEventCostPoint,
  TurnActor,
  TurnItem,
} from "./types/agent-session.js";

type TurnProjectionInput = {
  sessionId: string;
  harness: string;
  primaryModel: string | null;
  humanActor: Pick<TurnActor, "name" | "color">;
  timeline: readonly SessionTimelineEvent[];
  agents: readonly SyncedAgentSessionAgent[];
  events: readonly SyncedAgentSessionEvent[];
  tokenUsageByModel: readonly SyncedAgentSessionTokenUsage[];
  tokenEvents?: readonly TokenEventCostPoint[];
};

type TimelineProjectionInput = {
  metadata?: unknown;
};

type SessionMetadataMessage = {
  role: "human" | "assistant" | "system";
  timestamp: string;
  text: string | null;
  model?: string | null;
  isThinking?: boolean;
};

type ToolsTurnItem = Extract<TurnItem, { type: "tools" }>;

type TurnProjectionActors = {
  agent: TurnActor;
  human: TurnActor;
};

type StateFallbackInput = {
  status: string;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
};

const AgentSessionFallbackState = {
  PendingApproval: "PENDING_APPROVAL",
  Blocked: "BLOCKED",
  Running: "RUNNING",
  Completed: "COMPLETED",
} as const satisfies Record<string, AgentSessionState>;

const COMPLETED_SESSION_STATUSES = new Set(["completed"]);
const BLOCKED_SESSION_STATUSES = new Set(["abandoned", "error", "failed"]);
const AGENT_ACTOR_COLOR_TOKEN = "var(--primary)";
const TOOL_DETAIL_TEXT_LIMIT = 240;

// Claude Code fires a `Stop`/`SubagentStop` hook at the end of every agent turn.
// These markers carry no content: they render as bare "Stop" rows and, worse,
// sit between back-to-back tool runs so the projection splits what is really one
// burst of tool calls into several cards. Dropping them from the detail timeline
// removes the noise and lets the runs coalesce into a single tools card. Session
// lifecycle markers (`SessionStart`/`SessionEnd`) are intentionally retained.
// Matched against the raw producer hook name (not display text) at projection
// time and carried as the structured `isBoundary` flag.
const TURN_BOUNDARY_HOOK_TYPES = new Set(["stop", "subagentstop"]);

function isTurnBoundaryHookType(eventType: string): boolean {
  return TURN_BOUNDARY_HOOK_TYPES.has(eventType.toLowerCase());
}

/**
 * Convert synced session events into the timeline shape consumed by the shared
 * Agent Session detail renderer.
 */
export function projectAgentSessionTimelineEvents(
  events: readonly SyncedAgentSessionEvent[],
  input: TimelineProjectionInput = {}
): SessionTimelineEvent[] {
  const rows = [
    ...metadataMessages(input.metadata).map(messageToTimelineEvent),
    ...events.map(eventToTimelineEvent),
  ].sort((left, right) => {
    const byTime = safeTimelineMs(left) - safeTimelineMs(right);
    if (byTime !== 0) {
      return byTime;
    }
    return timelineKindOrder(left.kind) - timelineKindOrder(right.kind);
  });

  return rows.map((row, index) => ({ ...row, tl: index }));
}

/**
 * Convert synced events and agents into detail turn rows. The caller owns
 * identity-specific actor display values; this helper owns ordering and shared
 * event/subagent projection semantics.
 */
export function projectAgentSessionTurnItems(
  input: TurnProjectionInput
): TurnItem[] {
  const agentActor: TurnActor = {
    name: input.primaryModel,
    sessionId: input.sessionId,
    human: null,
    color: AGENT_ACTOR_COLOR_TOKEN,
    harness: input.harness,
  };
  const humanActor: TurnActor = {
    name: input.humanActor.name,
    sessionId: input.sessionId,
    human: input.humanActor.name,
    color: input.humanActor.color,
  };
  const actors: TurnProjectionActors = {
    agent: agentActor,
    human: humanActor,
  };

  // Filter turn-boundary markers before projecting so that tool runs separated
  // only by a Stop hook coalesce into one tools turn. `_row` stays stable because
  // it is keyed off the upstream-assigned `tl`, not this array's index.
  const timeline = input.timeline.filter(
    (event) => !isTurnBoundaryMarker(event)
  );

  const eventItems: TurnItem[] = [];
  for (let index = 0; index < timeline.length; index++) {
    const event = timeline[index]!;
    if (isToolLikeTimelineEvent(event)) {
      const toolsTurn = buildToolsTurn(timeline, index, agentActor);
      eventItems.push(toolsTurn.item);
      index = toolsTurn.endIndex;
      continue;
    }
    eventItems.push(buildTimelineEventTurnItem(event, index, actors));
  }

  const subagentItems = input.agents
    .filter(isSubagent)
    .map((agent, index): TurnItem => {
      const t = firstNonNull(agent.startedAt, agent.updatedAt, agent.endedAt);
      const tMs = t ? Date.parse(t) : Number.NaN;
      return {
        type: "subagent",
        _row: input.timeline.length + index,
        t: t ?? new Date(0).toISOString(),
        tMs: Number.isFinite(tMs) ? tMs : 0,
        cum: 0,
        actor: agentActor,
        sub: agent.name,
        subagentType: agent.subagentType ?? null,
        status: agent.status,
        model: input.primaryModel,
        duration: formatAgentDuration(agent),
        tokens: null,
        cost: null,
        body: buildSubagentBody(agent, input.events),
      };
    });

  const sorted = [...eventItems, ...subagentItems].sort((left, right) => {
    const byTime = getTurnItemTime(left) - getTurnItemTime(right);
    if (byTime !== 0) {
      return byTime;
    }
    return getTurnItemRow(left) - getTurnItemRow(right);
  });

  attributeTokenEventCosts(sorted, input.tokenEvents);

  return sorted;
}

const COST_BEARING_TYPES = new Set(["prompt", "say", "tools", "subagent"]);

function isCostBearingItem(
  item: TurnItem
): item is Extract<
  TurnItem,
  { type: "prompt" | "say" | "tools" | "subagent" }
> {
  return COST_BEARING_TYPES.has(item.type);
}

function findAttributionTarget(
  costBearing: Extract<
    TurnItem,
    { type: "prompt" | "say" | "tools" | "subagent" }
  >[],
  eventTMs: number
): number {
  let targetIndex = -1;
  for (let i = costBearing.length - 1; i >= 0; i--) {
    if (costBearing[i].tMs <= eventTMs) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0 || costBearing[targetIndex].type === "prompt") {
    const searchFrom = Math.max(targetIndex, 0);
    for (let i = searchFrom; i < costBearing.length; i++) {
      if (costBearing[i].type !== "prompt") {
        return i;
      }
    }
    return 0;
  }
  return targetIndex;
}

function attributeTokenEventCosts(
  items: TurnItem[],
  tokenEvents: readonly TokenEventCostPoint[] | undefined
): void {
  const costBearing = items.filter(isCostBearingItem);
  if (costBearing.length === 0) {
    return;
  }

  if (!tokenEvents || tokenEvents.length === 0) {
    return;
  }

  const deltas = new Map<number, number>();
  const sortedEvents = [...tokenEvents].sort((a, b) => a.tMs - b.tMs);

  for (const event of sortedEvents) {
    if (!Number.isFinite(event.tMs)) {
      continue;
    }
    const costUsd = event.costUsd ?? 0;
    if (costUsd === 0) {
      continue;
    }

    const targetIndex = findAttributionTarget(costBearing, event.tMs);
    deltas.set(targetIndex, (deltas.get(targetIndex) ?? 0) + costUsd);
  }

  let cumulative = 0;
  for (let i = 0; i < costBearing.length; i++) {
    const delta = deltas.get(i) ?? 0;
    cumulative += delta;
    costBearing[i].costDelta = delta;
    costBearing[i].cum = cumulative;
  }
}

function metadataMessages(metadata: unknown): SessionMetadataMessage[] {
  const metadataRecord = asRecord(metadata);
  const rawMessages = Array.isArray(metadataRecord?.messages)
    ? metadataRecord.messages
    : [];
  return rawMessages.flatMap((raw): SessionMetadataMessage[] => {
    const message = asRecord(raw);
    const role = messageRole(message?.role);
    const timestamp = stringValue(message?.timestamp);
    if (!(role && timestamp)) {
      return [];
    }
    return [
      {
        role,
        timestamp,
        text: stringValue(message?.text),
        model: stringValue(message?.model),
        isThinking: Boolean(message?.isThinking),
      },
    ];
  });
}

function messageToTimelineEvent(
  message: SessionMetadataMessage
): SessionTimelineEvent {
  const isThinking =
    message.role === "assistant" && Boolean(message.isThinking);
  return {
    t: message.timestamp,
    tMs: Date.parse(message.timestamp),
    kind: messageTimelineKind(message.role),
    who: message.role === "human" ? "human" : undefined,
    title: isThinking ? "Reasoning" : (message.model ?? message.role),
    detail: message.text ?? undefined,
    model:
      message.role === "assistant" ? (message.model ?? undefined) : undefined,
    isThinking: isThinking || undefined,
  };
}

function messageTimelineKind(
  role: SessionMetadataMessage["role"]
): SessionTimelineEvent["kind"] {
  if (role === "human") {
    return "human";
  }
  if (role === "assistant") {
    return "say";
  }
  return "event";
}

function eventToTimelineEvent(
  event: SyncedAgentSessionEvent
): SessionTimelineEvent {
  return {
    t: event.createdAt,
    tMs: Date.parse(event.createdAt),
    kind: eventKindToTimelineKind(event),
    title: event.toolName ?? event.eventType,
    detail: timelineEventDetail(event),
    err: event.eventType.toLowerCase().includes("error") || undefined,
    git: event.eventType.toLowerCase().includes("git") || undefined,
    isBoundary: isTurnBoundaryHookType(event.eventType) || undefined,
  };
}

/**
 * Derive the display workflow state for sessions that do not carry an explicit
 * persisted AgentSessionState. Ended sessions are terminal even if their status
 * has not yet been canonicalized.
 */
export function deriveAgentSessionFallbackState({
  status,
  awaitingInputSince,
  endedAt,
}: StateFallbackInput): AgentSessionState {
  const normalizedStatus = status.toLowerCase();
  if (COMPLETED_SESSION_STATUSES.has(normalizedStatus)) {
    return AgentSessionFallbackState.Completed;
  }
  if (BLOCKED_SESSION_STATUSES.has(normalizedStatus)) {
    return AgentSessionFallbackState.Blocked;
  }
  if (awaitingInputSince && !endedAt) {
    return AgentSessionFallbackState.PendingApproval;
  }
  if (endedAt) {
    return AgentSessionFallbackState.Completed;
  }
  return AgentSessionFallbackState.Running;
}

function eventKindToTimelineKind(
  event: SyncedAgentSessionEvent
): SessionTimelineEvent["kind"] {
  const eventType = event.eventType.toLowerCase();
  if (event.toolName) {
    return "tool";
  }
  if (eventType.includes("human") || eventType.includes("prompt")) {
    return "human";
  }
  if (eventType.includes("result")) {
    return "result";
  }
  if (eventType.includes("mcp")) {
    return "mcp";
  }
  if (eventType.includes("edit")) {
    return "edit";
  }
  return "event";
}

function timelineEventDetail(
  event: SyncedAgentSessionEvent
): string | undefined {
  if (event.summary) {
    return event.summary;
  }
  const data = asRecord(event.data);
  if (!data) {
    return undefined;
  }
  const toolInput = asRecord(data.tool_input);
  const toolResponse = asRecord(data.tool_response);
  const parts = [
    stringValue(
      data.file_path ??
        data.filePath ??
        toolInput?.file_path ??
        toolInput?.filePath
    ),
    stringValue(data.path ?? toolInput?.path),
    commandDetail(data, toolInput),
    stringValue(data.skillName ?? toolInput?.skillName),
    stringValue(data.mcpServer ?? toolInput?.mcpServer),
    stringValue(data.mcpMethod ?? toolInput?.mcpMethod),
    statusDetail(data, toolResponse),
    durationDetail(data, toolResponse),
  ].filter(Boolean);
  const diffDelta = asRecord(data.diffDelta ?? toolInput?.diffDelta);
  const add = numberValue(diffDelta?.add);
  const del = numberValue(diffDelta?.del);
  if (add || del) {
    parts.push(`+${add}/-${del}`);
  }
  const detail = parts.length > 0 ? parts.join(" · ") : undefined;
  return truncateDetail(detail);
}

function commandDetail(
  data: Record<string, unknown>,
  toolInput: Record<string, unknown> | null
): string | null {
  const command = stringValue(
    data.command ??
      data.cmd ??
      data.executable ??
      toolInput?.command ??
      toolInput?.cmd ??
      toolInput?.executable
  );
  const args = argumentText(
    data.args ?? data.arguments ?? toolInput?.args ?? toolInput?.arguments
  );
  if (command && args && !command.includes(args)) {
    return `${command} ${args}`;
  }
  return command ?? args;
}

function statusDetail(
  data: Record<string, unknown>,
  toolResponse: Record<string, unknown> | null
): string | undefined {
  const status = stringValue(data.status ?? toolResponse?.status);
  if (status) {
    return status;
  }
  const exitCode =
    data.exitCode ??
    data.exit_code ??
    toolResponse?.exitCode ??
    toolResponse?.exit_code;
  if (!(typeof exitCode === "number" && Number.isFinite(exitCode))) {
    return undefined;
  }
  return `exit ${Math.trunc(exitCode)}`;
}

function durationDetail(
  data: Record<string, unknown>,
  toolResponse: Record<string, unknown> | null
): string | undefined {
  const durationMs = numberValue(
    data.durationMs ?? data.duration_ms ?? toolResponse?.durationMs
  );
  return durationMs ? formatDurationMs(durationMs) : undefined;
}

function buildTimelineEventTurnItem(
  event: SessionTimelineEvent,
  index: number,
  actors: TurnProjectionActors
): TurnItem {
  const tMs = event.tMs ?? Date.parse(event.t);
  const row = event.tl ?? index;
  if (event.kind === "human") {
    return {
      type: "prompt",
      _row: row,
      t: event.t,
      tMs,
      cum: 0,
      actor: actors.human,
      text: event.detail ?? "",
    };
  }
  if (event.kind === "say") {
    return {
      type: "say",
      _row: row,
      t: event.t,
      tMs,
      cum: 0,
      actor: actors.agent,
      // Use the message text only. The label ("Reasoning"/model name) lives in
      // structured fields below so it is never dumped into the bubble body.
      text: event.detail ?? "",
      model: event.model ?? undefined,
      isThinking: event.isThinking,
    };
  }
  return {
    type: "event",
    _row: row,
    t: event.t,
    tMs,
    dot: toTimelineDot(event),
    text: event.detail ?? event.title ?? event.kind,
  };
}

function buildToolsTurn(
  timeline: readonly SessionTimelineEvent[],
  startIndex: number,
  actor: TurnActor
): { item: ToolsTurnItem; endIndex: number } {
  const first = timeline[startIndex]!;
  const run: SessionTimelineEvent[] = [first];
  let endIndex = startIndex;
  while (
    timeline[endIndex + 1] &&
    isToolLikeTimelineEvent(timeline[endIndex + 1]!)
  ) {
    endIndex += 1;
    run.push(timeline[endIndex]!);
  }
  const items = run.map((toolEvent) => ({
    label: toolEvent.title ?? toolEvent.kind,
    detail: toolEvent.detail ?? "",
    err: Boolean(toolEvent.err),
  }));
  const cats = countToolCats(items.map((item) => item.label));
  const failN = items.filter((item) => item.err).length;
  const last = run.at(-1) ?? first;
  const item: ToolsTurnItem = {
    type: "tools",
    _row: first.tl ?? startIndex,
    t: first.t,
    tMs: first.tMs ?? Date.parse(first.t),
    endMs: last.tMs ?? Date.parse(last.t),
    cum: 0,
    actor,
    summary: summarizeToolRun(cats, items.length),
    items,
    hasFail: failN > 0,
    failN,
    defaultOpen: failN > 0 || undefined,
    cats,
  };
  return { item, endIndex };
}

function isToolLikeTimelineEvent(event: SessionTimelineEvent): boolean {
  return (
    event.kind === "tool" ||
    event.kind === "edit" ||
    event.kind === "mcp" ||
    event.kind === "slash"
  );
}

/**
 * True for the content-free end-of-turn hook markers (`Stop`/`SubagentStop`),
 * identified by the structured `isBoundary` flag set from the raw producer hook
 * name — never by display text. Session lifecycle markers are excluded because
 * they are not flagged.
 */
function isTurnBoundaryMarker(event: SessionTimelineEvent): boolean {
  return event.isBoundary === true;
}

function countToolCats(labels: readonly string[]): {
  bash?: number;
  read?: number;
  tool?: number;
} {
  const cats: { bash?: number; read?: number; tool?: number } = {};
  for (const label of labels) {
    const normalized = label.toLowerCase();
    if (normalized.includes("bash") || normalized.includes("shell")) {
      cats.bash = (cats.bash ?? 0) + 1;
    } else if (normalized.includes("read")) {
      cats.read = (cats.read ?? 0) + 1;
    } else {
      cats.tool = (cats.tool ?? 0) + 1;
    }
  }
  return cats;
}

function summarizeToolRun(
  cats: { bash?: number; read?: number; tool?: number },
  total: number
): string {
  const segments = [`Ran ${total} ${total === 1 ? "tool" : "tools"}`];
  if (cats.bash) {
    segments.push(`${cats.bash} bash`);
  }
  if (cats.read) {
    segments.push(`${cats.read} read`);
  }
  if (cats.tool) {
    segments.push(`${cats.tool} tool`);
  }
  return segments.join(" · ");
}

function safeTimelineMs(event: SessionTimelineEvent): number {
  const value = event.tMs ?? Date.parse(event.t);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function timelineKindOrder(kind: SessionTimelineEvent["kind"]): number {
  switch (kind) {
    case "human":
      return 0;
    case "say":
      return 1;
    case "tool":
    case "edit":
    case "mcp":
    case "slash":
      return 2;
    default:
      return 3;
  }
}

function toTimelineDot(event: SessionTimelineEvent): "b" | "g" | "r" {
  if (event.err) {
    return "r";
  }
  if (event.git) {
    return "g";
  }
  return "b";
}

function isSubagent(agent: SyncedAgentSessionAgent): boolean {
  return (
    Boolean(agent.subagentType) || agent.type.toLowerCase().includes("subagent")
  );
}

function firstNonNull(
  ...values: Array<string | null | undefined>
): string | null {
  return values.find((value): value is string => Boolean(value)) ?? null;
}

function formatAgentDuration(agent: SyncedAgentSessionAgent): string | null {
  if (!agent.startedAt) {
    return null;
  }
  const startMs = Date.parse(agent.startedAt);
  const end = agent.endedAt ?? agent.updatedAt;
  const endMs = end ? Date.parse(end) : Number.NaN;
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return null;
  }
  return formatDurationMs(endMs - startMs);
}

function formatDurationMs(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function buildSubagentBody(
  agent: SyncedAgentSessionAgent,
  events: readonly SyncedAgentSessionEvent[]
): SubagentBodyLine[] {
  const body: SubagentBodyLine[] = [];

  if (agent.task) {
    body.push({ kind: "task", text: agent.task });
  }
  if (agent.currentTool) {
    body.push({ kind: "tool", text: agent.currentTool });
  }

  for (const event of events) {
    if (event.agentExternalId !== agent.externalAgentId) {
      continue;
    }
    body.push({
      kind: event.toolName ? "tool" : "event",
      text: event.toolName ?? event.eventType,
      t: event.createdAt,
      err: event.eventType.toLowerCase().includes("error") || undefined,
    });
  }

  body.push({
    kind: "status",
    text: agent.status,
    t:
      firstNonNull(agent.endedAt, agent.updatedAt, agent.startedAt) ??
      undefined,
    err: agent.status.toLowerCase().includes("fail") || undefined,
  });

  return body;
}

function getTurnItemTime(item: TurnItem): number {
  if ("tMs" in item) {
    return item.tMs;
  }
  return 0;
}

function getTurnItemRow(item: TurnItem): number {
  if ("_row" in item) {
    return item._row;
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function argumentText(value: unknown): string | null {
  const text = stringValue(value);
  if (text) {
    return text;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((item) =>
      typeof item === "string" || typeof item === "number" ? String(item) : ""
    )
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncateDetail(value: string | undefined): string | undefined {
  if (!value || value.length <= TOOL_DETAIL_TEXT_LIMIT) {
    return value;
  }
  return `${value.slice(0, TOOL_DETAIL_TEXT_LIMIT - 3)}...`;
}

function messageRole(value: unknown): SessionMetadataMessage["role"] | null {
  return value === "human" || value === "assistant" || value === "system"
    ? value
    : null;
}
