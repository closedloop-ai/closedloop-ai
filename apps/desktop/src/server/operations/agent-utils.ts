import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gatewayLog } from "../../main/gateway-logger.js";
import type { TaskProgress } from "../../main/job-store.js";
import {
  getActiveAgents,
  isNativeLoop,
} from "./observability/active-agents-registry.js";

export type ActiveAgent = {
  agentId: string;
  agentType: string;
  agentName: string;
  startedAt: string;
};

export async function readAgentTypeFiles(
  agentTypesDir: string,
  logSource: string
): Promise<ActiveAgent[]> {
  if (!existsSync(agentTypesDir)) {
    return [];
  }

  const agents: ActiveAgent[] = [];
  try {
    const files = await readdir(agentTypesDir);

    for (const file of files) {
      if (file.includes("-")) {
        continue;
      }

      try {
        const content = await readFile(path.join(agentTypesDir, file), "utf-8");
        const [agentType, agentName, startedAt] = content.trim().split("|");
        if (agentType && agentName) {
          agents.push({
            agentId: file,
            agentType,
            agentName,
            startedAt: startedAt ?? "",
          });
        }
      } catch (error) {
        gatewayLog.warn(
          logSource,
          `Failed to read agent-type file ${path.join(agentTypesDir, file)}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  } catch {
    // Best effort
  }

  return agents;
}

/**
 * Resolve the active agents for a loop. Native loops (NativePrompt /
 * ClaudeSlashCommand) source active agents from the in-memory registry fed by
 * the harness adapter — they have no `.agent-types/` directory, and the
 * registry is authoritative even when empty (empty-not-errored, AC-005).
 * Legacy plugin loops fall through to scanning `agentTypesDir`.
 */
export function readActiveAgents(
  agentTypesDir: string,
  logSource: string,
  loopId?: string
): Promise<ActiveAgent[]> {
  if (loopId && isNativeLoop(loopId)) {
    return Promise.resolve(getActiveAgents(loopId));
  }

  return readAgentTypeFiles(agentTypesDir, logSource);
}

export async function readPlanProgress(
  planPath: string
): Promise<{ taskProgress?: TaskProgress; currentTaskId?: string }> {
  if (!existsSync(planPath)) {
    return {};
  }

  try {
    let planContent = await readFile(planPath, "utf-8");
    planContent = planContent.replaceAll(/,\s*([\]}])/g, "$1");
    const plan = JSON.parse(planContent) as {
      pendingTasks?: Array<{ id?: string }>;
      completedTasks?: unknown[];
    };
    const pendingTasks = Array.isArray(plan.pendingTasks)
      ? plan.pendingTasks
      : [];
    const completedTasks = Array.isArray(plan.completedTasks)
      ? plan.completedTasks
      : [];
    const firstPending = pendingTasks[0];
    return {
      taskProgress: {
        pending: pendingTasks.length,
        completed: completedTasks.length,
        total: pendingTasks.length + completedTasks.length,
      },
      currentTaskId: firstPending?.id,
    };
  } catch {
    return {};
  }
}
