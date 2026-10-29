/**
 * @file sync-lane-span-producers.ts
 * @description Which `SyncLane` members have a `sync.batch` span producer.
 *
 * The suites that ship one span per lane read the producing set from here, so a
 * new `SyncLane` member fails `tsc` until it is answered.
 *
 * `trace_comments` stays in the shared contract for installed builds, but this
 * desktop no longer has a trace-comment lane (ISS-11213), so it emits none.
 */
import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";

const LANE_EMITS_BATCH_SPANS: Record<SyncLane, boolean> = {
  [SyncLane.SessionMetadata]: true,
  [SyncLane.InvocationParts]: true,
  [SyncLane.TranscriptArchive]: true,
  [SyncLane.ComponentInventory]: true,
  [SyncLane.TraceComments]: false,
};

export const SPAN_PRODUCING_SYNC_LANES: readonly SyncLane[] = Object.values(
  SyncLane
).filter((lane) => LANE_EMITS_BATCH_SPANS[lane]);
