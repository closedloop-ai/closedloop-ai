/** IPC channel names the approvals handler registers and the preload bridge invokes. */
export const ApprovalsIpcChannel = {
  GetPendingApprovals: "desktop:get-pending-approvals",
  GetResolvedApprovals: "desktop:get-resolved-approvals",
  ClearResolvedApprovals: "desktop:clear-resolved-approvals",
  ApproveApproval: "desktop:approve-approval",
  DenyApproval: "desktop:deny-approval",
  AlwaysAllowApproval: "desktop:always-allow-approval",
  RemoveAlwaysAllowRule: "desktop:remove-always-allow-rule",
  ClearPendingApprovals: "desktop:clear-pending-approvals",
} as const;

export type ApprovalsIpcChannel =
  (typeof ApprovalsIpcChannel)[keyof typeof ApprovalsIpcChannel];
