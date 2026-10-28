/** Desktop-to-cloud sync lanes in burn-down emission order. */
export const SyncLaneId = {
  SessionMetadata: "session_metadata",
  InvocationParts: "invocation_parts",
  TranscriptArchive: "transcript_archive",
  ComponentInventory: "component_inventory",
} as const;
export type SyncLaneId = (typeof SyncLaneId)[keyof typeof SyncLaneId];

export const SYNC_LANE_IDS: readonly SyncLaneId[] = [
  SyncLaneId.SessionMetadata,
  SyncLaneId.InvocationParts,
  SyncLaneId.TranscriptArchive,
  SyncLaneId.ComponentInventory,
];
