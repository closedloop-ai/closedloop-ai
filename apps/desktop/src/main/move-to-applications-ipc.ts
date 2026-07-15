import { MOVE_TO_APPLICATIONS_IPC_CHANNEL } from "../shared/move-to-applications-ipc-channel.js";

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: { sender?: unknown }) => Promise<unknown> | unknown
  ) => void;
};

type MoveToApplicationsIpcDeps = {
  canMoveToApplications: () => boolean;
  isTrustedSender: (sender: unknown) => boolean;
  moveToApplications: () => Promise<boolean> | boolean;
};

/** Registers the trusted renderer IPC handler for moving the app bundle. */
export function registerMoveToApplicationsIpcHandler(
  ipcMainLike: IpcMainLike,
  deps: MoveToApplicationsIpcDeps
): void {
  ipcMainLike.handle(MOVE_TO_APPLICATIONS_IPC_CHANNEL, async (event) => {
    if (!deps.isTrustedSender(event.sender)) {
      throw new Error("untrusted sender");
    }
    if (!deps.canMoveToApplications()) {
      throw new Error("update install is not blocked");
    }
    return await deps.moveToApplications();
  });
}
