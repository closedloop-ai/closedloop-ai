import { DesktopSessionReplayIpcChannel } from "../../shared/desktop-session-replay-ipc-channel.js";
import { isTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

/**
 * ISS-12257: the renderer's replay recording report, for main's replay
 * recording fence (`createDesktopReplayRecordingFence`). Only the trusted
 * renderer window may report.
 */
export function registerDesktopReplayRecordingIpcHandler(
  ipcMainLike: IpcMainLike,
  deps: {
    isTrustedSender: (sender: unknown) => boolean;
    report: (payload: unknown) => void;
  }
): void {
  ipcMainLike.handle(
    DesktopSessionReplayIpcChannel.ReportRecording,
    (event, payload) => {
      if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
        return false;
      }
      deps.report(payload);
      return true;
    }
  );
}
