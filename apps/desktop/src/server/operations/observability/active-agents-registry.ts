import type { ActiveAgentDelta } from "@closedloop-ai/loops-api/observability";
import type { ActiveAgent } from "../agent-utils.js";

/**
 * In-memory active-agents registry for native loops (D-005, AC-005).
 *
 * Stays desktop-side: it feeds the desktop active-agents IPC/UI specifically
 * (ECS has no active-agents feed). It is fed by the loops-api Claude adapter's
 * spawn/stop lifecycle deltas (routed through the native observability session)
 * and replaces the legacy `.agent-types/` directory scan for native loops.
 *
 * The legacy plugin path writes `.agent-types/` files; native loops have no such
 * directory, so `readActiveAgents` consults this registry for loops marked
 * native and falls back to the directory scan otherwise.
 */

/** Loops launched via a native launch mode, keyed by loopId. */
const nativeLoops = new Set<string>();

/** loopId → (agentId → ActiveAgent) for currently-running subagents. */
const activeAgentsByLoop = new Map<string, Map<string, ActiveAgent>>();

/**
 * Mark a loop as native so `readActiveAgents` sources its agents from this
 * registry rather than the legacy `.agent-types/` directory — even when the
 * loop currently has zero running subagents (empty-not-errored, AC-005).
 */
export function markNativeLoop(loopId: string): void {
  nativeLoops.add(loopId);
}

/** Whether a loop is registry-sourced (native) rather than directory-scanned. */
export function isNativeLoop(loopId: string): boolean {
  return nativeLoops.has(loopId);
}

/** Apply one adapter-derived active-agent lifecycle delta. */
export function recordActiveAgentDelta(
  loopId: string,
  delta: ActiveAgentDelta
): void {
  if (delta.kind === "start") {
    let agents = activeAgentsByLoop.get(loopId);
    if (!agents) {
      agents = new Map<string, ActiveAgent>();
      activeAgentsByLoop.set(loopId, agents);
    }
    agents.set(delta.agentId, {
      agentId: delta.agentId,
      agentType: delta.agentType,
      agentName: delta.agentName,
      startedAt: delta.startedAt,
    });
    return;
  }
  // stop
  activeAgentsByLoop.get(loopId)?.delete(delta.agentId);
}

/** Snapshot the currently-running subagents for a loop. */
export function getActiveAgents(loopId: string): ActiveAgent[] {
  const agents = activeAgentsByLoop.get(loopId);
  return agents ? [...agents.values()] : [];
}

/**
 * Clear all registry state for a loop. Called from the run-envelope exit path
 * regardless of outcome so a loop that exits abnormally does not leak entries.
 */
export function clearActiveAgents(loopId: string): void {
  activeAgentsByLoop.delete(loopId);
  nativeLoops.delete(loopId);
}
