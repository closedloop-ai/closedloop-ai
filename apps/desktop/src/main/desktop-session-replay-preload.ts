import type { DesktopSessionReplayBridge } from "../shared/desktop-session-replay-bridge.js";
import { DesktopSessionReplayIpcChannel } from "../shared/desktop-session-replay-ipc-channel.js";

type IpcInvokeLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

/**
 * ISS-12257: the replay recording report, assembled here so
 * `preload-common.ts` gains one spread rather than a method body.
 * `test/desktop-session-replay-preload-hop.test.ts` covers the spread.
 */
export function createDesktopSessionReplayDesktopApi(
  ipcRendererLike: IpcInvokeLike
): Required<DesktopSessionReplayBridge> {
  return {
    reportDesktopReplayRecording: (recording) =>
      ipcRendererLike.invoke(
        DesktopSessionReplayIpcChannel.ReportRecording,
        recording
      ),
  };
}
