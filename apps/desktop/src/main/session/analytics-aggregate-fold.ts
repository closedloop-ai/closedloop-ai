import type { SharedAgentSessionAnalytics } from "../../shared/shared-agent-sessions-contract.js";
import type { AgentSessionAnalyticsAggregate } from "../agent-sync/agent-session-read-model.js";

/**
 * FEA-2038: fold the O(grouped) analytics aggregate into the canonical
 * `SharedAgentSessionAnalytics`. The aggregate's byTool/byRepository rows map
 * 1:1 to the contract shape; byAgentType converts the SQL duration fold
 * (durationTotalMs/durationCount) into `avgDurationMs` and omits those two
 * fields, matching `buildAgentTypeBreakdowns`. `byProject` is empty (local
 * desktop cannot resolve cloud projects), matching `buildAnalytics`.
 *
 * ISS-6005: hoisted out of `shared-agent-sessions-api.ts`. That file is on the
 * `noExcessiveLinesPerFile` grandfather list, which is SHRINK-ONLY, and this
 * change added a field to it — so a cohesive unit comes out in the same commit
 * (AGENTS.md → "File Size and Organization": pay down the debt, do not just
 * freeze it). This mapper is the natural seam: pure, single-caller, and it
 * depends on nothing else in that module.
 */
export function foldAnalyticsAggregate(
  aggregate: AgentSessionAnalyticsAggregate
): SharedAgentSessionAnalytics {
  return {
    viewerScope: "self",
    byTool: aggregate.byTool.map((group) => ({
      toolName: group.toolName,
      invocationCount: group.invocationCount,
      errorCount: group.errorCount,
      sessionCount: group.sessionCount,
    })),
    byAgentType: aggregate.byAgentType.map((group) => ({
      agentType: group.agentType,
      count: group.count,
      successCount: group.successCount,
      failedCount: group.failedCount,
      avgDurationMs:
        group.durationCount > 0
          ? group.durationTotalMs / group.durationCount
          : null,
    })),
    byRepository: aggregate.byRepository.map((group) => ({
      repositoryFullName: group.repositoryFullName,
      sessionCount: group.sessionCount,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      estimatedCost: group.estimatedCost,
      errorCount: group.errorCount,
    })),
    byProject: [],
  };
}
