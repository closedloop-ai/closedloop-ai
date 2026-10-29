/** ISS-12257: what a replay recording started under. */
export type DesktopReplayRecordingReport = {
  signedIn: boolean;
  /** The `DesktopAuthState.authGeneration` the recording started under. */
  authGeneration?: number;
};

export type DesktopSessionReplayBridge = {
  /**
   * ISS-12257: tells main the sign-in state and auth generation a replay
   * recording starts under. Main refuses replay batches until a report matches
   * its own, which holds from a sign-in or sign-out until the renderer has
   * discarded the old recording and reported the next one.
   */
  reportDesktopReplayRecording?: (
    recording: DesktopReplayRecordingReport
  ) => Promise<unknown>;
};
