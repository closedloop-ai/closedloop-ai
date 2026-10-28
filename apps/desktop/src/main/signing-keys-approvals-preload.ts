import { ApprovalsIpcChannel } from "../shared/approvals-ipc-channel.js";

type IpcInvokeLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

/**
 * The tool-approval half of the desktop bridge, spread into `createDesktopApi`
 * (preload-common.ts) so that module stays under the file-size ceiling.
 */
export function createSigningKeysAndApprovalsDesktopApi(
  ipcRendererLike: IpcInvokeLike
) {
  return {
    getPendingApprovals: () =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.GetPendingApprovals
      ) as Promise<unknown>,
    approveApproval: (approvalId: string) =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.ApproveApproval,
        approvalId
      ) as Promise<unknown>,
    denyApproval: (approvalId: string) =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.DenyApproval,
        approvalId
      ) as Promise<unknown>,
    alwaysAllowApproval: (approvalId: string) =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.AlwaysAllowApproval,
        approvalId
      ) as Promise<unknown>,
    clearPendingApprovals: () =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.ClearPendingApprovals
      ) as Promise<unknown>,
    getResolvedApprovals: () =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.GetResolvedApprovals
      ) as Promise<unknown>,
    clearResolvedApprovals: () =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.ClearResolvedApprovals
      ) as Promise<unknown>,
  };
}
