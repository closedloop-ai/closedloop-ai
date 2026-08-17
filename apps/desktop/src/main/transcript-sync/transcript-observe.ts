/**
 * @file transcript-observe.ts
 * @description The archive lane's single write-into-the-queue primitive: stat a
 * transcript file and record its fingerprint through
 * `TranscriptSyncStore.observe`, which is what actually enqueues (or leaves
 * settled) a row.
 *
 * Every lane that grows the queue funnels through here — the discovery sweep,
 * the live/hook enqueue, and the ISS-4390 sidecar sweep — so the fingerprint
 * fields (`sourcePathHash`, compute-target id, clock) are populated one way and
 * a new call site cannot silently omit one.
 */
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import type {
  TranscriptFileRef,
  TranscriptFileStat,
  TranscriptSyncClass,
} from "./transcript-sync-types.js";

/** The service-owned helpers an observe needs to fill a fingerprint row. */
export type TranscriptObserveDeps = {
  statFile: (path: string) => Promise<TranscriptFileStat | null>;
  hashPath: (path: string) => string;
  getComputeTargetId: () => string | null;
  now: () => string;
};

export async function observeTranscriptRef(
  deps: TranscriptObserveDeps,
  store: TranscriptSyncStore,
  ref: TranscriptFileRef,
  syncClass: TranscriptSyncClass
): Promise<void> {
  const fileStat = await deps.statFile(ref.sourcePath);
  await store.observe({
    externalSessionId: ref.externalSessionId,
    fileKey: ref.fileKey,
    sourceHarness: ref.sourceHarness,
    sourcePath: ref.sourcePath,
    sourcePathHash: deps.hashPath(ref.sourcePath),
    mtimeMs: fileStat?.mtimeMs ?? null,
    size: fileStat?.size ?? null,
    syncClass,
    currentComputeTargetId: deps.getComputeTargetId(),
    now: deps.now(),
  });
}
