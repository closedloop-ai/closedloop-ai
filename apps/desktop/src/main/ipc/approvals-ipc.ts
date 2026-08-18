import type {
  ApprovalStore,
  PendingApproval,
} from "../approvals/approval-store.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

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

type IpcMainLike = {
  handle: (
    channel: ApprovalsIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type ApprovalsIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  approvalStore: ApprovalStore;
  settingsStore: SettingsStore;
  saveAlwaysAllowRuleForPending: (pending: PendingApproval) => void;
};

function assertApprovalId(approvalId: unknown): string {
  if (typeof approvalId !== "string" || !approvalId.trim()) {
    throw new Error("approvalId is required");
  }
  return approvalId.trim();
}

export function registerApprovalsIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: ApprovalsIpcDeps
): void {
  ipcMainLike.handle(ApprovalsIpcChannel.GetPendingApprovals, () =>
    deps.approvalStore.listPending()
  );
  ipcMainLike.handle(ApprovalsIpcChannel.GetResolvedApprovals, () =>
    deps.approvalStore.listResolved()
  );
  ipcMainLike.handle(ApprovalsIpcChannel.ClearResolvedApprovals, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    deps.approvalStore.clearResolved();
    return [];
  });
  ipcMainLike.handle(
    ApprovalsIpcChannel.ApproveApproval,
    (event, approvalId) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      deps.approvalStore.approve(assertApprovalId(approvalId));
      return deps.approvalStore.listPending();
    }
  );
  ipcMainLike.handle(ApprovalsIpcChannel.DenyApproval, (event, approvalId) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    deps.approvalStore.deny(assertApprovalId(approvalId));
    return deps.approvalStore.listPending();
  });
  ipcMainLike.handle(
    ApprovalsIpcChannel.AlwaysAllowApproval,
    (event, approvalId) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const id = assertApprovalId(approvalId);
      const pending = deps.approvalStore.getPendingById(id);
      if (!pending) {
        return {
          pendingApprovals: deps.approvalStore.listPending(),
          settings: deps.settingsStore.getAll(),
        };
      }
      deps.saveAlwaysAllowRuleForPending(pending);
      deps.approvalStore.alwaysAllow(id);
      return {
        pendingApprovals: deps.approvalStore.listPending(),
        settings: deps.settingsStore.getAll(),
      };
    }
  );
  ipcMainLike.handle(
    ApprovalsIpcChannel.RemoveAlwaysAllowRule,
    (event, ruleId) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (typeof ruleId !== "string" || !ruleId.trim()) {
        throw new Error("ruleId is required");
      }
      const settings = deps.settingsStore.getAll();
      const updated = (settings.alwaysAllowRules ?? []).filter(
        (r) => r.id !== ruleId.trim()
      );
      deps.settingsStore.setAlwaysAllowRules(updated);
      return { alwaysAllowRules: updated };
    }
  );
  ipcMainLike.handle(ApprovalsIpcChannel.ClearPendingApprovals, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    deps.approvalStore.clear();
    return deps.approvalStore.listPending();
  });
}
