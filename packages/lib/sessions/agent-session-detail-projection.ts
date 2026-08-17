import {
  AgentSessionState,
  type SessionTimelineEvent,
  type SubagentBodyLine,
  type SyncedAgentSessionAgent,
  type SyncedAgentSessionEvent,
  type SyncedAgentSessionTokenUsage,
  type TokenEventCostPoint,
  type TranscriptTurnIdentity,
  type TurnActor,
  type TurnItem,
} from "@repo/api/src/types/agent-session";
import {
  resolveToolCallDetailState,
  type ToolItem,
} from "@repo/api/src/types/agent-session-tool-call";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { resolveActivityEndMs } from "../session-trace/derivation";
import {
  asRecord,
  commandDetail,
  durationDetail,
  firstNonNull,
  formatDurationMs,
  getTurnItemRow,
  getTurnItemTime,
  numberValue,
  statusDetail,
  stringValue,
} from "./agent-session-projection-utils";
import {
  eventIndicatesToolError,
  toolCallDetailFields,
} from "./agent-session-tool-detail";
import { commandUserTurnId } from "./command-user-turn-id";
import {
  attributeTokenEventCosts,
  type SubagentCostSpan,
} from "./subagent-cost-attribution";

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
  /** ISS-5075: `events` is a partial PREFIX (the cloud read hit its ceiling). */
  eventsTruncated?: true;
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
  userTurnId?: string;
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

// The terminal FAILURE status, mapped to its own terminal AgentSessionState
// (FEA-4287). ISS-6588 removed the sibling `completed`/`abandoned` sets with the
// branches that read them; ISS-5592 then removed the `failed` alias, once the
// desktop stopped manufacturing that spelling from a stored `error`.
const ERROR_SESSION_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.ERROR,
]);

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

  const timestampOrdinals = new Map<string, number>();
  return rows.map((row, index) => {
    const timestampOrdinal = timestampOrdinals.get(row.t) ?? 0;
    timestampOrdinals.set(row.t, timestampOrdinal + 1);
    return {
      ...row,
      tl: index,
      transcriptIdentity: {
        ...row.transcriptIdentity,
        timestamp: row.t,
        timestampOrdinal,
      },
    };
  });
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

  const subagentSpans: SubagentCostSpan[] = [];
  const subagentItems = input.agents
    .filter(isSubagent)
    .map((agent, index): TurnItem => {
      const t = firstNonNull(agent.startedAt, agent.updatedAt, agent.endedAt);
      const tMs = t ? Date.parse(t) : Number.NaN;
      const startMs = Number.isFinite(tMs) ? tMs : 0;
      const item: Extract<TurnItem, { type: "subagent" }> = {
        type: "subagent",
        _row: input.timeline.length + index,
        t: t ?? new Date(0).toISOString(),
        tMs: startMs,
        cum: 0,
        actor: agentActor,
        sub: agent.name,
        subagentType: agent.subagentType ?? null,
        status: agent.status,
        model: input.primaryModel,
        duration: formatAgentDuration(
          agent,
          input.events,
          input.eventsTruncated
        ),
        // FEA-4178: `cost` is populated below by `attributeTokenEventCosts` from
        // this sub-agent's OWNED token-event spend (metered by `agentExternalId`,
        // or the timestamp delta when a lone sub-agent has ownerless events, and
        // omitted when overlapping sub-agents make ownerless attribution
        // ambiguous). `tokens` has no truthful per-sub-agent source — the cost
        // points carry no token counts — so it stays null and the collapsed box
        // drops that meta part rather than fabricate a figure.
        tokens: null,
        cost: null,
        body: buildSubagentBody(agent, input.events),
        transcriptIdentity: agentTranscriptIdentity(agent, t, index),
      };
      const endMs = resolveAgentEndMs(agent, input.events);
      subagentSpans.push({
        externalAgentId: agent.externalAgentId ?? null,
        startMs,
        endMs: Number.isFinite(endMs) && endMs >= startMs ? endMs : startMs,
        item,
      });
      return item;
    });

  const sorted = [...eventItems, ...subagentItems].sort((left, right) => {
    const byTime = getTurnItemTime(left) - getTurnItemTime(right);
    if (byTime !== 0) {
      return byTime;
    }
    return getTurnItemRow(left) - getTurnItemRow(right);
  });

  attributeTokenEventCosts(sorted, input.tokenEvents, subagentSpans);

  return sorted;
}

function metadataMessages(metadata: unknown): SessionMetadataMessage[] {
  const metadataRecord = asRecord(metadata);
  const commandTurnIds = commandTurnIdsByTimestamp(metadataRecord);
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
    const associatedCommandTurnId =
      role === "human" ? commandTurnIds.get(timestamp)?.shift() : undefined;
    return [
      {
        role,
        timestamp,
        text: stringValue(message?.text),
        model: stringValue(message?.model),
        isThinking: Boolean(message?.isThinking),
        userTurnId: stringValue(message?.userTurnId) ?? associatedCommandTurnId,
      },
    ];
  });
}

function commandTurnIdsByTimestamp(
  metadata: Record<string, unknown> | null
): Map<string, string[]> {
  const byTimestamp = new Map<string, string[]>();
  const commands = metadata?.slashCommands;
  if (!Array.isArray(commands)) {
    return byTimestamp;
  }
  for (const [index, raw] of commands.entries()) {
    const command = asRecord(raw);
    const name = stringValue(command?.name);
    const timestamp = stringValue(command?.timestamp);
    if (!(name && timestamp)) {
      continue;
    }
    const turnId = commandUserTurnId(
      {
        name,
        timestamp,
        userTurnId: stringValue(command?.userTurnId),
        normalizedName: stringValue(command?.normalizedName),
      },
      index
    );
    const existing = byTimestamp.get(timestamp);
    if (existing) {
      if (!existing.includes(turnId)) {
        existing.push(turnId);
      }
    } else {
      byTimestamp.set(timestamp, [turnId]);
    }
  }
  return byTimestamp;
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
    transcriptIdentity: {
      ...(message.userTurnId ? { userTurnId: message.userTurnId } : {}),
      timestamp: message.timestamp,
    },
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
    err: eventIndicatesToolError(event) || undefined,
    git: event.eventType.toLowerCase().includes("git") || undefined,
    isBoundary: isTurnBoundaryHookType(event.eventType) || undefined,
    transcriptIdentity: {
      eventId: event.externalEventId,
      ...(event.providerToolUseId
        ? { providerToolUseId: event.providerToolUseId }
        : {}),
      ...(event.agentExternalId
        ? { externalAgentId: event.agentExternalId }
        : {}),
      timestamp: event.createdAt,
    },
    // FEA-3696: preserve the source event identity so the tools-turn projection
    // can mint a `callId` that is stable across the cloud DB-events path and the
    // desktop transcript path (both key on `externalEventId`), surviving a lazy
    // detail re-fetch. Only tool rows carry it.
    ...(event.toolName ? { toolCallId: event.externalEventId } : {}),
    // FEA-3547 + FEA-3696: preserve the full per-call detail so a tools-turn row
    // can expand to reveal what this individual call did, and stamp a TRUTHFUL
    // detail state. Only tool rows carry it. When the producer supplied `data`
    // (transcript path) the fields are populated and the state is
    // available/truncated/malformed; the cloud DB-events path strips `data`
    // (FEA-2718 keeps no event `data` column), so the fields stay undefined and
    // the state is `unavailable` — the detail lives only in the archived
    // transcript and the row says so instead of claiming "no detail".
    ...(event.toolName ? toolCallDetailFields(event) : {}),
  };
}

/**
 * Derive the display workflow state for sessions that do not carry an explicit
 * persisted AgentSessionState. Ended sessions are terminal even if their status
 * has not yet been canonicalized.
 *
 * ISS-6588 removed the `completed`/`abandoned` branches and the FEA-3551 PR
 * rescue that rode on one of them. Both spellings were retired by ISS-4654 and
 * are unreachable — the cloud ingest fold makes them unwritable (ISS-5981), a
 * production count returned 0, and desktop migration 0042 collapsed every local
 * row that held one — so the branches classified nothing.
 *
 * The cost, decided by Chris on 2026-08-15 rather than assumed: an `abandoned`
 * row with no `endedAt` now falls through to `Running` instead of `Completed`.
 * That is only reachable if a producer starts writing a spelling this build
 * retired, which is the thing ISS-5592 established cannot happen.
 */
export function deriveAgentSessionFallbackState({
  status,
  awaitingInputSince,
  endedAt,
}: StateFallbackInput): AgentSessionState {
  const normalizedStatus = status.toLowerCase();
  // FEA-4287: preserve the terminal FAILURE outcome instead of collapsing to
  // Blocked, so the detail projection matches what the Sessions LIST renders.
  if (ERROR_SESSION_STATUSES.has(normalizedStatus)) {
    return AgentSessionState.Error;
  }
  if (awaitingInputSince && !endedAt) {
    return AgentSessionState.PendingApproval;
  }
  if (endedAt) {
    return AgentSessionState.Completed;
  }
  return AgentSessionState.Running;
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
      transcriptIdentity: event.transcriptIdentity,
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
      transcriptIdentity: event.transcriptIdentity,
    };
  }
  return {
    type: "event",
    _row: row,
    t: event.t,
    tMs,
    dot: toTimelineDot(event),
    text: event.detail ?? event.title ?? event.kind,
    transcriptIdentity: event.transcriptIdentity,
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
  const items = run.map((toolEvent, runIndex) => ({
    label: toolEvent.title ?? toolEvent.kind,
    detail: toolEvent.detail ?? "",
    err: Boolean(toolEvent.err),
    // FEA-3547: carry the preserved per-call detail so each row expands to show
    // what that call did. Only defined keys are attached (the fields are all
    // optional) so a transcript-less row stays a bare summary that renders its
    // "no detail captured" empty state.
    ...toolItemDetailFrom(toolEvent, `${first.tl ?? startIndex}-${runIndex}`),
    transcriptIdentity: toolEvent.transcriptIdentity,
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
    transcriptIdentity: first.transcriptIdentity,
  };
  return { item, endIndex };
}

/**
 * FEA-3547: project the preserved per-call detail on a timeline tool event onto
 * the optional `ToolItem` expansion fields. Returns only the keys that resolved
 * to a value (the fields are all optional/additive), so a transcript-less row
 * carries none and renders its "no detail captured" empty state. `fallbackId`
 * is a run-stable synthetic key used only when the transcript supplied no id.
 *
 * FEA-3696: always carries the stable `callId` (identity, preserved across cloud
 * and desktop) and the truthful `detailState`, so a detail-less cloud row still
 * has an identity the UI can key + lazily re-fetch and renders an honest
 * `unavailable`/`redacted` panel rather than a bare "no detail" message.
 */
function toolItemDetailFrom(
  event: SessionTimelineEvent,
  fallbackId: string
): Partial<Pick<ToolItemDetail, keyof ToolItemDetail>> {
  const detail: Partial<ToolItemDetail> = {};
  if (event.toolInput !== undefined) {
    detail.input = event.toolInput;
    if (event.toolInputTruncated) {
      detail.inputTruncated = true;
    }
  }
  if (event.toolOutput !== undefined) {
    detail.output = event.toolOutput;
    if (event.toolOutputTruncated) {
      detail.outputTruncated = true;
    }
  }
  if (typeof event.toolDurationMs === "number") {
    detail.durationMs = event.toolDurationMs;
  }
  if (event.toolStatus) {
    detail.status = event.toolStatus;
  }
  // FEA-3696: stable per-call identity for EVERY tool row — the source event id
  // when available (identical across cloud + desktop), else the run-stable
  // synthetic key. Preserved so the expanded UI keys rows consistently and a
  // lazy detail re-fetch can address the exact call.
  detail.callId = event.toolCallId ?? fallbackId;
  // Only mint the (legacy FEA-3547) `id` when there is real inline detail to key
  // — a bare summary row needs no such id (the UI keys those by index). Checked
  // BEFORE stamping the always-present `callId`/`detailState` so the semantic is
  // preserved.
  const hasInlineDetail =
    detail.input !== undefined ||
    detail.output !== undefined ||
    detail.durationMs !== undefined ||
    detail.status !== undefined;
  if (hasInlineDetail) {
    detail.id = fallbackId;
  }
  // FEA-3696: carry the truthful detail state. Prefer the state the timeline
  // event already resolved (the production path, via `toolCallDetailFields`),
  // which is authoritative for a hydrate-able tool row — including a legitimate
  // `unavailable` for the cloud DB-events path, whose detail genuinely lives in
  // the archived transcript keyed by the source `externalEventId`.
  if (event.toolDetailState) {
    detail.detailState = event.toolDetailState;
    return detail;
  }
  // No explicit state: this is either a caller that hand-built the timeline with
  // inline input/output, or a tool-LIKE row (`edit`/`mcp`/`slash` classified only
  // by eventType substring) that carries no `toolName` and so never ran through
  // `toolCallDetailFields`. Resolve from the assembled inline fields so the state
  // can never contradict them (e.g. `unavailable` beside a real input).
  if (hasInlineDetail) {
    detail.detailState = resolveToolCallDetailState(detail);
    return detail;
  }
  // Detail-less AND not a hydrate-able tool row: it has only a SYNTHETIC fallback
  // `callId`, never the source event's `externalEventId`, so there is no keyed,
  // re-fetchable transcript detail behind it. Stamping `unavailable` here would
  // LIE — that state specifically promises "detail exists elsewhere and can be
  // fetched lazily". Say `malformed` instead: this row simply has no readable
  // per-call detail, with no false promise of re-fetchability.
  detail.detailState = "malformed";
  return detail;
}

// Single source of truth: the expansion fields are exactly the optional
// per-call detail keys on the canonical `ToolItem`. Derive (required) from it so
// the projection and the wire type can never drift.
type ToolItemDetail = Required<
  Pick<
    ToolItem,
    | "id"
    | "callId"
    | "detailState"
    | "input"
    | "inputTruncated"
    | "output"
    | "outputTruncated"
    | "durationMs"
    | "status"
  >
>;

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

function formatAgentDuration(
  agent: SyncedAgentSessionAgent,
  events: readonly SyncedAgentSessionEvent[],
  eventsTruncated?: true
): string | null {
  if (!agent.startedAt) {
    return null;
  }
  // ISS-5075: over a truncated prefix, an agent that never reported `endedAt`
  // has no end anchor this payload can honor. Its last SERVED event is only the
  // last one we read (a confident undercount), and an agent with none left in
  // the prefix falls back to the mutable, ever-growing `updatedAt` (FEA-3451).
  // Unavailable is the only honest answer for both.
  if (eventsTruncated && !agent.endedAt) {
    return null;
  }
  const startMs = Date.parse(agent.startedAt);
  const endMs = resolveAgentEndMs(agent, events);
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return null;
  }
  return formatDurationMs(endMs - startMs);
}

/**
 * End anchor for a subagent's duration. `updated_at` is bumped on every touch /
 * re-sync, so anchoring an un-ended subagent to it renders an inflated duration
 * (FEA-3451; the same overstatement class FEA-3427 fixed for the session
 * wall-clock in `resolveTraceEndMs`). Prefer the last real agent-event timestamp
 * — the extent of this subagent's event stream — and fall back to the mutable
 * `updatedAt` only when the subagent carries no activity timestamps at all.
 * The "endedAt → last-activity → updatedAt" algorithm is the shared
 * `resolveActivityEndMs` SSOT; this only supplies the subagent's own event
 * timestamps.
 */
function resolveAgentEndMs(
  agent: SyncedAgentSessionAgent,
  events: readonly SyncedAgentSessionEvent[]
): number {
  return resolveActivityEndMs({
    endedAt: agent.endedAt,
    updatedAt: agent.updatedAt,
    activityTimestamps: agentEventTimestamps(agent, events),
  });
}

function* agentEventTimestamps(
  agent: SyncedAgentSessionAgent,
  events: readonly SyncedAgentSessionEvent[]
): Generator<string> {
  for (const event of events) {
    if (event.agentExternalId === agent.externalAgentId) {
      yield event.createdAt;
    }
  }
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
      err: eventIndicatesToolError(event) || undefined,
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

function agentTranscriptIdentity(
  agent: SyncedAgentSessionAgent,
  timestamp: string | null,
  timestampOrdinal: number
): TranscriptTurnIdentity {
  return {
    ...(agent.id ? { agentId: agent.id } : {}),
    externalAgentId: agent.externalAgentId,
    ...(timestamp ? { timestamp, timestampOrdinal } : {}),
  };
}
