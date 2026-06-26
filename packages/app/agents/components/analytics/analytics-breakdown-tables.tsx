"use client";

import type {
  AgentSessionAgentTypeBreakdown,
  AgentSessionProjectBreakdown,
  AgentSessionRepositoryBreakdown,
  AgentSessionToolBreakdown,
} from "@repo/api/src/types/agent-session";
import { formatDurationMs } from "../../../shared/lib/format-duration-ms";
import {
  formatCost,
  formatNumber,
  formatTokenCount,
} from "../../../shared/lib/format-utils";
import {
  MonitoringAgentTypeTable,
  MonitoringRepositoryBreakdown,
  MonitoringToolUsageTable,
} from "./monitoring-breakdown-tables";

export function ToolUsageBreakdownTable({
  data,
}: Readonly<{
  data: AgentSessionToolBreakdown[];
}>) {
  return (
    <MonitoringToolUsageTable
      rows={data.slice(0, 20).map((row) => {
        const errorRate =
          row.invocationCount > 0
            ? (row.errorCount / row.invocationCount) * 100
            : 0;
        return {
          errorCount: formatNumber(row.errorCount),
          errorRateLabel: errorRate > 0 ? `${errorRate.toFixed(1)}%` : null,
          errorRateVariant: errorRate > 10 ? "destructive" : "secondary",
          hasErrors: row.errorCount > 0,
          invocationCount: formatNumber(row.invocationCount),
          sessionCount: formatNumber(row.sessionCount),
          toolName: row.toolName,
        };
      })}
      totalInvocationsLabel={formatNumber(
        data.reduce((sum, row) => sum + row.invocationCount, 0)
      )}
    />
  );
}

export function AgentTypeBreakdownTable({
  data,
}: Readonly<{
  data: AgentSessionAgentTypeBreakdown[];
}>) {
  return (
    <MonitoringAgentTypeTable
      rows={data.slice(0, 20).map((row) => {
        const total = row.successCount + row.failedCount;
        const successRate = total > 0 ? (row.successCount / total) * 100 : null;
        return {
          agentType: row.agentType,
          avgDurationLabel: formatDurationMs(row.avgDurationMs),
          count: formatNumber(row.count),
          failedCount: formatNumber(row.failedCount),
          successCount: formatNumber(row.successCount),
          successRateLabel:
            successRate === null ? null : `${successRate.toFixed(0)}%`,
          successRateVariant:
            successRate !== null && successRate >= 90
              ? "secondary"
              : "destructive",
        };
      })}
      totalAgentsLabel={formatNumber(
        data.reduce((sum, row) => sum + row.count, 0)
      )}
    />
  );
}

export function RepositoryBreakdownTable({
  projects,
  repositories,
}: Readonly<{
  repositories: AgentSessionRepositoryBreakdown[];
  projects: AgentSessionProjectBreakdown[];
}>) {
  return (
    <MonitoringRepositoryBreakdown
      projectRows={projects.slice(0, 15).map((row) => ({
        cost: formatCost(row.estimatedCost),
        projectId: row.projectId,
        projectName: row.projectName,
        sessionCount: formatNumber(row.sessionCount),
        tokenCount: formatTokenCount(row.inputTokens + row.outputTokens),
      }))}
      repositoryRows={repositories.slice(0, 15).map((row) => ({
        cost: formatCost(row.estimatedCost),
        errorCount: formatNumber(row.errorCount),
        hasErrors: row.errorCount > 0,
        repositoryFullName: row.repositoryFullName,
        sessionCount: formatNumber(row.sessionCount),
        tokenCount: formatTokenCount(row.inputTokens + row.outputTokens),
      }))}
    />
  );
}
