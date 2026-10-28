/** ISS-12257: IPC between the renderer's replay recording and main's replay request hook. */
export const DesktopSessionReplayIpcChannel = {
  /** Renderer to main: what a replay recording starts under. */
  ReportRecording: "desktop:report-replay-recording",
} as const;
export type DesktopSessionReplayIpcChannel =
  (typeof DesktopSessionReplayIpcChannel)[keyof typeof DesktopSessionReplayIpcChannel];
