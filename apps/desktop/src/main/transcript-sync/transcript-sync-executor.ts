/**
 * @file transcript-sync-executor.ts
 * @description Per-file sync executor for the transcript archive lane
 * (FEA-2715 / PLN-1288 task 4). For one fingerprinted file it: stats the file,
 * cuts the sync window at the last complete newline, checksums `[0, planEndOffset)`
 * in a streamed pass, asks the control plane for an authoritative plan
 * (`noop` | `fullPut` | `multipart`), streams the delta parts straight to S3,
 * calls `complete`, and persists the server-verified cursor. Server state is
 * authoritative (recovery invariant 2): the client re-plans from the returned
 * offset rather than trusting local state, and a resumed/compacted file just
 * yields a different plan.
 *
 * All filesystem + checksum access is injected so the logic is unit-testable
 * without touching disk or the network.
 */
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import type { DesktopTranscriptsClient } from "../desktop-transcripts-client.js";
import {
  computeWindowChecksums as defaultComputeWindowChecksums,
  findNewlineBoundary as defaultFindNewlineBoundary,
  openBoundedReadStream,
  type WindowChecksums,
} from "./transcript-checksums.js";
import type {
  TranscriptFileStat,
  TranscriptFingerprint,
} from "./transcript-sync-types.js";

export type TranscriptSyncResult =
  | { kind: "uploaded"; caughtUp: boolean }
  | { kind: "noop" }
  | { kind: "skipped"; reason: string };

export type TranscriptSyncExecutorDeps = {
  store: TranscriptSyncStore;
  client: DesktopTranscriptsClient;
  /** Current online compute target id, or null when offline. */
  getComputeTargetId: () => string | null;
  now: () => string;
  statFile?: (path: string) => Promise<TranscriptFileStat | null>;
  /**
   * Open a streaming reader over the `[start, end)` byte window. Streamed (not
   * buffered) so multi-GB transcripts are never loaded into memory
   * (PRD FR4 / AC5), matching the checksum path.
   */
  openByteRangeStream?: (path: string, start: number, end: number) => Readable;
  computeWindowChecksums?: (
    path: string,
    endOffset: number
  ) => Promise<WindowChecksums>;
  findNewlineBoundary?: (path: string, maxOffset: number) => Promise<number>;
};

export type TranscriptSyncExecutor = {
  syncFile(fingerprint: TranscriptFingerprint): Promise<TranscriptSyncResult>;
};

/** Best-effort `{ size, mtimeMs }`; null on any stat error. Shared with the service. */
export async function statTranscriptFile(
  path: string
): Promise<TranscriptFileStat | null> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Cached prefix hash to send as `prefixSha256`, or undefined when it can't be
 * trusted (unknown offset, or belongs to a different compute target — the
 * server then re-plans from its own truth).
 */
function resolvePrefixSha256(
  fp: TranscriptFingerprint,
  computeTargetId: string
): string | undefined {
  if (
    fp.syncedComputeTargetId === computeTargetId &&
    fp.syncedByteOffset > 0 &&
    fp.syncedSha256
  ) {
    return fp.syncedSha256;
  }
  return undefined;
}

export function createTranscriptSyncExecutor(
  deps: TranscriptSyncExecutorDeps
): TranscriptSyncExecutor {
  const statFile = deps.statFile ?? statTranscriptFile;
  const openByteRangeStream = deps.openByteRangeStream ?? openBoundedReadStream;
  const computeWindowChecksums =
    deps.computeWindowChecksums ?? defaultComputeWindowChecksums;
  const findNewlineBoundary =
    deps.findNewlineBoundary ?? defaultFindNewlineBoundary;
  const { store, client, getComputeTargetId, now } = deps;

  async function uploadPlanBytes(
    fp: TranscriptFingerprint,
    plan: Extract<
      Awaited<ReturnType<typeof client.syncPlan>>,
      { mode: "fullPut" | "multipart" }
    >,
    crc64NvmeBase64: string
  ): Promise<void> {
    if (plan.mode === "fullPut") {
      // Full rewrite from 0 — the checksum header is the whole-window CRC64NVME.
      // Stream the window straight to S3 instead of buffering it (PRD FR4 / AC5).
      const body = openByteRangeStream(fp.sourcePath, 0, plan.planEndOffset);
      await client.uploadPut(
        plan.url,
        body,
        plan.planEndOffset,
        crc64NvmeBase64
      );
      return;
    }
    // Append (or from-scratch multipart): stream each delta part's raw bytes.
    for (const part of plan.parts) {
      const body = openByteRangeStream(
        fp.sourcePath,
        part.offset,
        part.offset + part.byteLength
      );
      await client.uploadPart(part.url, body, part.byteLength);
    }
  }

  async function applyPlan(
    fp: TranscriptFingerprint,
    plan: Awaited<ReturnType<typeof client.syncPlan>>,
    computeTargetId: string,
    windowChecksums: WindowChecksums,
    planEndOffset: number
  ): Promise<TranscriptSyncResult> {
    if (plan.mode === "noop") {
      const caughtUp = plan.syncedByteOffset >= planEndOffset;
      await store.recordUploaded({
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        syncedByteOffset: plan.syncedByteOffset,
        syncedSha256: caughtUp ? windowChecksums.sha256Hex : fp.syncedSha256,
        storedEtag: plan.storedEtag,
        syncedComputeTargetId: computeTargetId,
        caughtUp,
        now: now(),
      });
      return { kind: "noop" };
    }

    await uploadPlanBytes(fp, plan, windowChecksums.crc64NvmeBase64);

    const completed = await client.complete({
      computeTargetId,
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      mode: plan.mode,
      uploadId: plan.mode === "multipart" ? plan.uploadId : undefined,
      planEndOffset,
      sha256: windowChecksums.sha256Hex,
      crc64nvme: windowChecksums.crc64NvmeBase64,
    });

    const caughtUp = completed.syncedByteOffset >= planEndOffset;
    await store.recordUploaded({
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      syncedByteOffset: completed.syncedByteOffset,
      // The window checksum covers `[0, planEndOffset)`; only adopt it as the new
      // prefix hash when the server confirms it caught up to that end. When the
      // server acked a smaller `syncedByteOffset`, that hash describes a wider
      // range than the cursor, so keep the prior prefix hash (mirroring the
      // `noop` branch) — otherwise the next sync sends a `prefixSha256` for the
      // wrong byte range and the compaction/rewrite guard forces a full
      // re-upload from offset 0.
      syncedSha256: caughtUp ? windowChecksums.sha256Hex : fp.syncedSha256,
      storedEtag: completed.storedEtag,
      syncedComputeTargetId: computeTargetId,
      caughtUp,
      now: now(),
    });
    return { kind: "uploaded", caughtUp };
  }

  async function syncFile(
    fp: TranscriptFingerprint
  ): Promise<TranscriptSyncResult> {
    const computeTargetId = getComputeTargetId();
    if (!computeTargetId) {
      // Caller only drives the executor while online; guard defensively.
      throw new Error("no online compute target");
    }

    // Claim the row as `uploading` BEFORE any stat/checksum read (FEA-2827). The
    // stat + newline scan + full-window checksum below take multi-seconds on a
    // large transcript; if the row stayed `queued` through that window, a
    // concurrent `observe` (terminal Stop hook or sweep) on a file that just
    // grew would see `status !== uploading`, treat it as changed, and advance
    // `lastMtimeMs`/`lastSize` past the appended bytes. Once this upload settled
    // to `idle`, the growth would look already-observed and the trailing bytes
    // `[planEndOffset, newSize)` would never re-queue — permanently lost if that
    // growth was the file's final size (session end). Marking `uploading` first
    // makes `planObservation` preserve the growth signal instead of consuming it.
    await store.markUploading(fp.externalSessionId, fp.fileKey, now());

    const fileStat = await statFile(fp.sourcePath);
    if (!fileStat) {
      await store.markIdle(fp.externalSessionId, fp.fileKey, now());
      return { kind: "skipped", reason: "file missing" };
    }

    const planEndOffset = await findNewlineBoundary(
      fp.sourcePath,
      fileStat.size
    );
    if (planEndOffset === 0) {
      // No complete JSONL line yet — nothing durable to sync.
      await store.markIdle(fp.externalSessionId, fp.fileKey, now());
      return { kind: "skipped", reason: "no complete line" };
    }

    const windowChecksums = await computeWindowChecksums(
      fp.sourcePath,
      planEndOffset
    );

    const plan = await client.syncPlan({
      computeTargetId,
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      sourceHarness: fp.sourceHarness,
      sourcePathHash: fp.sourcePathHash,
      planEndOffset,
      sha256: windowChecksums.sha256Hex,
      crc64nvme: windowChecksums.crc64NvmeBase64,
      sourceMtime: new Date(fileStat.mtimeMs).toISOString(),
      prefixSha256: resolvePrefixSha256(fp, computeTargetId),
    });

    return applyPlan(fp, plan, computeTargetId, windowChecksums, planEndOffset);
  }

  return { syncFile };
}
