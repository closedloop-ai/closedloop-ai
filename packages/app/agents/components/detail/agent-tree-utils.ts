import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type {
  AgentStatus,
  SessionAgent,
} from "@repo/app/agents/lib/session-types";

export type AgentTreeNode = {
  agent: SyncedAgentSessionAgent;
  children: AgentTreeNode[];
  depth: number;
  durationMs: number | null;
  eventCount: number;
  errorCount: number;
  toolInvocationCount: number;
  isSuccess: boolean;
  isFailed: boolean;
};

/**
 * Builds the canonical session agent tree used by detail rendering and
 * analytics panels. Orphaned agents stay visible as root nodes.
 */
export function buildAgentTree(
  agents: SyncedAgentSessionAgent[],
  events: SyncedAgentSessionEvent[]
): AgentTreeNode[] {
  const eventsByAgent = new Map<string, SyncedAgentSessionEvent[]>();
  for (const event of events) {
    if (!event.agentExternalId) {
      continue;
    }
    const list = eventsByAgent.get(event.agentExternalId);
    if (list) {
      list.push(event);
    } else {
      eventsByAgent.set(event.agentExternalId, [event]);
    }
  }

  const nodeMap = new Map<string, AgentTreeNode>();
  for (const agent of agents) {
    const agentEvents = eventsByAgent.get(agent.externalAgentId) ?? [];
    const durationMs = computeDuration(agent.startedAt, agent.endedAt);
    const statusLower = agent.status.toLowerCase();

    nodeMap.set(agent.externalAgentId, {
      agent,
      children: [],
      depth: 0,
      durationMs,
      eventCount: agentEvents.length,
      errorCount: agentEvents.filter(isErrorEvent).length,
      toolInvocationCount: agentEvents.filter((e) => e.toolName).length,
      isSuccess: statusLower === "completed",
      isFailed: statusLower.includes("fail") || statusLower.includes("error"),
    });
  }

  const roots: AgentTreeNode[] = [];
  for (const agent of agents) {
    const node = nodeMap.get(agent.externalAgentId);
    if (!node) {
      continue;
    }
    const parentId = agent.parentExternalAgentId;
    if (parentId && nodeMap.has(parentId)) {
      const parent = nodeMap.get(parentId)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  assignDepths(roots, 0);
  return roots;
}

/**
 * Adapts the canonical tree into the design-system session detail tree shape.
 */
export function buildSessionAgents(
  agents: SyncedAgentSessionAgent[],
  events: SyncedAgentSessionEvent[]
): SessionAgent[] {
  const roots = buildAgentTree(agents, events);

  function buildNode(node: AgentTreeNode): SessionAgent {
    return {
      id: node.agent.externalAgentId,
      sessionId: "session",
      name: node.agent.name,
      type:
        node.depth === 0 && !node.agent.parentExternalAgentId
          ? "main"
          : "subagent",
      subagentType: node.agent.subagentType,
      status: normalizeAgentStatus(node.agent.status),
      task: node.agent.task,
      currentTool: node.agent.currentTool,
      startedAt:
        node.agent.startedAt ??
        node.agent.updatedAt ??
        node.agent.endedAt ??
        "",
      updatedAt: node.agent.updatedAt,
      endedAt: node.agent.endedAt,
      label: `${node.eventCount} events`,
      children: node.children.map(buildNode),
    };
  }

  return roots.map(buildNode);
}

/**
 * Flattens a canonical agent tree in display order.
 */
export function flattenTree(roots: AgentTreeNode[]): AgentTreeNode[] {
  const result: AgentTreeNode[] = [];
  function walk(node: AgentTreeNode) {
    result.push(node);
    for (const child of node.children) {
      walk(child);
    }
  }
  for (const root of roots) {
    walk(root);
  }
  return result;
}

/**
 * Returns the Tailwind background color class for an agent status marker.
 */
export function getStatusColor(status: string): string {
  const lower = status.toLowerCase();
  if (lower === "completed") {
    return "bg-emerald-500";
  }
  if (lower.includes("fail") || lower.includes("error")) {
    return "bg-red-500";
  }
  if (lower === "running" || lower === "active") {
    return "bg-blue-500";
  }
  if (lower === "awaiting_input" || lower === "awaiting_user") {
    return "bg-purple-500";
  }
  return "bg-gray-400";
}

/**
 * Returns the Tailwind border color class for an agent status marker.
 */
export function getStatusBorderColor(status: string): string {
  const lower = status.toLowerCase();
  if (lower === "completed") {
    return "border-emerald-500";
  }
  if (lower.includes("fail") || lower.includes("error")) {
    return "border-red-500";
  }
  if (lower === "running" || lower === "active") {
    return "border-blue-500";
  }
  if (lower === "awaiting_input" || lower === "awaiting_user") {
    return "border-purple-500";
  }
  return "border-gray-400";
}

/**
 * Returns events that cannot be attributed to a known session agent. Detail
 * analytics use this to keep stale or mixed producer/storage states visible.
 */
export function getUnattributedEvents(
  agents: SyncedAgentSessionAgent[],
  events: SyncedAgentSessionEvent[]
): SyncedAgentSessionEvent[] {
  const knownAgentIds = new Set(
    agents.map((agent) => agent.externalAgentId).filter(Boolean)
  );

  return events.filter(
    (event) =>
      !(event.agentExternalId && knownAgentIds.has(event.agentExternalId))
  );
}

/**
 * Classifies error-like telemetry without assuming the producer used one exact
 * event type string.
 */
export function isErrorEvent(event: SyncedAgentSessionEvent): boolean {
  return event.eventType.toLowerCase().includes("error");
}

function normalizeAgentStatus(status: string): AgentStatus {
  const normalized = status.toLowerCase();
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "error";
  }
  if (
    normalized.includes("complete") ||
    normalized.includes("done") ||
    normalized.includes("success")
  ) {
    return "completed";
  }
  if (normalized.includes("wait") || normalized.includes("queued")) {
    return "waiting";
  }
  if (normalized.includes("idle")) {
    return "idle";
  }
  return "working";
}

function computeDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  if (!(startedAt && endedAt)) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return end - start;
}

function assignDepths(nodes: AgentTreeNode[], depth: number) {
  for (const node of nodes) {
    node.depth = depth;
    assignDepths(node.children, depth + 1);
  }
}
