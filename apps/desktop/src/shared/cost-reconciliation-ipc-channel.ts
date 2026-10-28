/** IPC channel names the cost-reconciliation handler registers and the preload bridge invokes. */
export const CostReconciliationIpcChannel = {
  RunCostReconciliation: "desktop:run-cost-reconciliation",
  ListCostReconciliation: "desktop:list-cost-reconciliation",
  GetClaudeCodeAnalytics: "desktop:get-claude-code-analytics",
} as const;

export type CostReconciliationIpcChannel =
  (typeof CostReconciliationIpcChannel)[keyof typeof CostReconciliationIpcChannel];
