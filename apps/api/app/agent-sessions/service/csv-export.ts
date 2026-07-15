import { toLocalDateOnly } from "@/lib/date-only";
import { decimalToNumber, tokenCountToNumber } from "./coercion";
import { displayUserName, toBasicUser } from "./projections";
import type { AgentSessionExportRecord } from "./records";

export type AgentSessionCsvExportRow = {
  date: string;
  user: string;
  team: string;
  project: string;
  harnessType: string;
  model: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
};

export function toCsvExportRows(
  record: AgentSessionExportRecord
): AgentSessionCsvExportRow[] {
  const teamNames = (record.user?.teamMemberships ?? [])
    .map((membership) => membership.team.name)
    .filter(Boolean)
    .join(", ");
  const baseRow = {
    date: toLocalDateOnly(record.sessionStartedAt, record.deviceTimeZone),
    user: record.user
      ? displayUserName(toBasicUser(record.user))
      : "Unattributed",
    team: teamNames || "Unattributed",
    project: record.artifact.project?.name ?? "Unattributed",
    harnessType: record.harness,
  };

  if (record.tokenUsageByModel.length === 0) {
    return [
      {
        ...baseRow,
        model: record.model ?? "Unknown",
        sessionCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCost: 0,
      },
    ];
  }

  return record.tokenUsageByModel.map((usage) => ({
    ...baseRow,
    model: usage.model,
    sessionCount: 1,
    inputTokens: tokenCountToNumber(usage.inputTokens),
    outputTokens: tokenCountToNumber(usage.outputTokens),
    cacheCreationTokens: tokenCountToNumber(usage.cacheWriteTokens),
    cacheReadTokens: tokenCountToNumber(usage.cacheReadTokens),
    estimatedCost: decimalToNumber(usage.estimatedCost),
  }));
}
