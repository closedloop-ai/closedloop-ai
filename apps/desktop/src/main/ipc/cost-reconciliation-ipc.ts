import type { ClaudeCodeAnalyticsService } from "../cost/claude-code-analytics-service.js";
import type { CostReconciliationService } from "../cost/cost-reconciliation-service.js";
import type { ReconciliationQuery } from "../cost/reconciliation-store.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const CostReconciliationIpcChannel = {
  RunCostReconciliation: "desktop:run-cost-reconciliation",
  ListCostReconciliation: "desktop:list-cost-reconciliation",
  GetClaudeCodeAnalytics: "desktop:get-claude-code-analytics",
} as const;

export type CostReconciliationIpcChannel =
  (typeof CostReconciliationIpcChannel)[keyof typeof CostReconciliationIpcChannel];

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Runtime-validate an optional reconciliation list query from IPC. Unknown
 * fields are dropped; malformed values are ignored rather than throwing so the
 * diagnostics view degrades to "all rows" instead of erroring.
 */
function parseReconciliationQuery(
  value: unknown
): ReconciliationQuery | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const query: ReconciliationQuery = {};
  if (typeof record.from === "string" && ISO_DAY_RE.test(record.from)) {
    query.from = record.from;
  }
  if (typeof record.to === "string" && ISO_DAY_RE.test(record.to)) {
    query.to = record.to;
  }
  if (record.vendor === "anthropic" || record.vendor === "openai") {
    query.vendor = record.vendor;
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

/**
 * Extract the Claude Code analytics query from an untrusted IPC payload. Only a
 * numeric `windowDays` is read; the service clamps it to a sane range, so any
 * other shape becomes `undefined` (the service then uses its default window).
 */
function parseClaudeCodeAnalyticsQuery(
  value: unknown
): { windowDays?: number } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.windowDays === "number" &&
    Number.isFinite(record.windowDays)
  ) {
    return { windowDays: record.windowDays };
  }
  return undefined;
}

type IpcMainLike = {
  handle: (
    channel: CostReconciliationIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type CostReconciliationIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  costReconciliation: CostReconciliationService;
  claudeCodeAnalytics: ClaudeCodeAnalyticsService;
};

export function registerCostReconciliationIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: CostReconciliationIpcDeps
): void {
  ipcMainLike.handle(
    CostReconciliationIpcChannel.RunCostReconciliation,
    (event) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return deps.costReconciliation.runReconciliationNow();
    }
  );
  ipcMainLike.handle(
    CostReconciliationIpcChannel.ListCostReconciliation,
    (_event, query) =>
      deps.costReconciliation.listRows(parseReconciliationQuery(query))
  );
  // FEA-1436: Claude Code per-user usage (Anthropic's own estimate). Read-only;
  // uses the same Anthropic Admin key. The query is runtime-validated (untrusted
  // IPC) and the result carries no key material — only per-actor usage rows.
  ipcMainLike.handle(
    CostReconciliationIpcChannel.GetClaudeCodeAnalytics,
    (_event, query) =>
      deps.claudeCodeAnalytics.fetchAnalytics(
        parseClaudeCodeAnalyticsQuery(query)
      )
  );
}
