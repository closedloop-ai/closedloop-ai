/**
 * @file transcript-sync-executor-fixtures.ts
 * @description Shared fakes for the per-file transcript-sync EXECUTOR tests
 * (FEA-2715): the injected recording store, recording client, fake filesystem
 * deps, and the fingerprint/temp-file builders. Distinct from
 * `transcript-sync-fixtures.ts` (which fakes the SERVICE — scheduler/queue), so
 * both the executor plan/upload suite and the ISS-4647 source-recovery suite can
 * import one copy instead of each redeclaring them (#4150, per AGENTS.md "extract
 * shared test fixtures into the nearest shared module").
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { TranscriptSyncStore } from "../../src/main/database/transcript-sync-store.js";
import type { DesktopTranscriptsClient } from "../../src/main/transcript/desktop-transcripts-client.js";
import type { TranscriptFingerprint } from "../../src/main/transcript-sync/transcript-sync-types.js";

export const PATH = "/home/.claude/projects/p/sess-1.jsonl";
export const NOW = "2026-07-09T00:00:00.000Z";
export const A32 = "a".repeat(32);
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function fingerprint(
  overrides: Partial<TranscriptFingerprint> = {}
): TranscriptFingerprint {
  return {
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    sourcePath: PATH,
    sourcePathHash: "hash-1",
    lastMtimeMs: 1000,
    lastSize: 500,
    syncedByteOffset: 0,
    syncedSha256: null,
    storedEtag: null,
    syncedComputeTargetId: null,
    status: "queued",
    syncClass: "live",
    retryCount: 0,
    missingSourceCount: 0,
    nextAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

export type RecordingStore = TranscriptSyncStore & {
  uploaded: unknown[];
  idled: string[];
  /**
   * ISS-4815: identities settled through the DURABLE cloud-uploaded terminal
   * (`markCloudUploaded`), kept separate from `idled` so a test can prove the
   * acknowledgement was persisted as such rather than collapsed into a bare
   * `idle` the stranded-blob recovery would re-arm on the next launch.
   */
  cloudUploaded: string[];
  /**
   * ISS-4815: the compute target each cloud acknowledgement was scoped to. An
   * ack only describes the archive held by the target that gave it, so the
   * executor must thread that id through — otherwise the recovery cannot tell a
   * still-valid ack from one belonging to a target the user has left.
   */
  cloudUploadedTargets: (string | null)[];
  uploadingMarks: string[];
  dead: { id: string; key: string; reason: string }[];
  failures: {
    id: string;
    key: string;
    retryCount: number;
    missingSourceCount: number;
    dead: boolean;
    nextAttemptAt: string | null;
    lastError: string;
  }[];
};

export function recordingStore(): RecordingStore {
  const store = {
    uploaded: [] as unknown[],
    idled: [] as string[],
    cloudUploaded: [] as string[],
    cloudUploadedTargets: [] as (string | null)[],
    uploadingMarks: [] as string[],
    dead: [] as { id: string; key: string; reason: string }[],
    failures: [] as {
      id: string;
      key: string;
      retryCount: number;
      missingSourceCount: number;
      dead: boolean;
      nextAttemptAt: string | null;
      lastError: string;
    }[],
    get: () => Promise.resolve(null),
    listAll: () => Promise.resolve([]),
    listReady: () => Promise.resolve([]),
    observe: () => Promise.resolve(fingerprint()),
    markUploading: (id: string, key: string) => {
      store.uploadingMarks.push(`${id}:${key}`);
      return Promise.resolve();
    },
    markIdle: (id: string, key: string) => {
      store.idled.push(`${id}:${key}`);
      return Promise.resolve();
    },
    markCloudUploaded: (
      id: string,
      key: string,
      _now: string,
      computeTargetId: string | null
    ) => {
      store.cloudUploaded.push(`${id}:${key}`);
      store.cloudUploadedTargets.push(computeTargetId);
      return Promise.resolve();
    },
    markDead: (id: string, key: string, reason: string) => {
      store.dead.push({ id, key, reason });
      return Promise.resolve();
    },
    recordUploaded: (input: unknown) => {
      store.uploaded.push(input);
      return Promise.resolve();
    },
    recordFailure: (input: {
      externalSessionId: string;
      fileKey: string;
      retryCount: number;
      missingSourceCount: number;
      dead: boolean;
      nextAttemptAt: string | null;
      lastError: string;
    }) => {
      store.failures.push({
        id: input.externalSessionId,
        key: input.fileKey,
        retryCount: input.retryCount,
        missingSourceCount: input.missingSourceCount,
        dead: input.dead,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
      });
      return Promise.resolve();
    },
    requeueStale: () => Promise.resolve(0),
  };
  return store as unknown as RecordingStore;
}

/** Drain a streamed upload body, returning the exact bytes received. */
export async function streamedBody(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export type RecordingClient = DesktopTranscriptsClient & {
  planRequests: unknown[];
  puts: { url: string; length: number; body: Buffer; crc: string }[];
  parts: { url: string; length: number; body: Buffer }[];
  completeRequests: unknown[];
  skipRequests: unknown[];
};

export function recordingClient(
  plan: Awaited<ReturnType<DesktopTranscriptsClient["syncPlan"]>>,
  completeOffset: number
): RecordingClient {
  const client = {
    planRequests: [] as unknown[],
    puts: [] as {
      url: string;
      length: number;
      body: Buffer;
      crc: string;
    }[],
    parts: [] as { url: string; length: number; body: Buffer }[],
    completeRequests: [] as unknown[],
    skipRequests: [] as unknown[],
    syncPlan: (request: unknown) => {
      client.planRequests.push(request);
      return Promise.resolve(plan);
    },
    uploadPut: async (
      url: string,
      body: Readable,
      contentLength: number,
      crc: string
    ) => {
      client.puts.push({
        url,
        length: contentLength,
        body: await streamedBody(body),
        crc,
      });
    },
    uploadPart: async (url: string, body: Readable, contentLength: number) => {
      client.parts.push({
        url,
        length: contentLength,
        body: await streamedBody(body),
      });
    },
    complete: (request: unknown) => {
      client.completeRequests.push(request);
      return Promise.resolve({
        status: "uploaded" as const,
        syncedByteOffset: completeOffset,
        storedEtag: "etag-final",
        sessionDetailId: null,
      });
    },
    skip: (request: unknown) => {
      client.skipRequests.push(request);
      return Promise.resolve({
        status: "skipped" as const,
        permanentFailureReason: "too_large" as const,
        sessionDetailId: null,
      });
    },
  };
  return client as unknown as RecordingClient;
}

export function fakeFsDeps(fileBytes: Buffer | null) {
  return {
    statFile: () =>
      Promise.resolve(
        fileBytes ? { size: fileBytes.length, mtimeMs: 1000 } : null
      ),
    prepareUploadWindow: (_path: string, rawEndOffset: number) =>
      Promise.resolve(
        fakeUploadWindow(
          (fileBytes ?? Buffer.alloc(0)).subarray(0, rawEndOffset)
        )
      ),
    findNewlineBoundary: (_path: string, maxOffset: number) =>
      Promise.resolve(maxOffset),
  };
}

export function fakeUploadWindow(bytes: Buffer) {
  return {
    planEndOffset: bytes.length,
    checksums: {
      sha256Hex: `sha-${bytes.length}`,
      crc64NvmeBase64: `crc-${bytes.length}`,
      byteLength: bytes.length,
    },
    openRangeStream: (start: number, end: number) =>
      Readable.from([bytes.subarray(start, end)]),
    dispose: () => Promise.resolve(),
  };
}

export function withTempTranscript(
  name: string,
  content: string,
  run: (path: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "transcript-sync-executor-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}
