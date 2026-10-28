import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TranscriptUploadStatus,
  transcriptCompleteRequestSchema,
  transcriptSkipRequestSchema,
  transcriptSyncPlanRequestSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import {
  type VibeCorpusTimeMap,
  vibeCorpusTimeMapPath,
  vibeCorpusTimeMapSchema,
} from "@repo/api/src/vibe-seed-corpus-time";
import {
  pickVibeCorpusMainTranscript,
  vibeCorpusTranscriptText,
} from "@repo/api/src/vibe-seed-corpus-transcript";
import { config as awsStorageConfig } from "@repo/aws/s3-client";
import {
  type TranscriptObjectChecksums,
  transcriptObjectChecksums,
} from "@repo/aws/transcript-checksums";
import {
  S3_CHECKSUM_CRC64NVME_HEADER,
  TRANSCRIPT_CONTENT_TYPE,
} from "@repo/aws/transcript-storage";
import { withDb } from "@repo/database";
import { redactJsonlTranscriptByteChunks } from "@repo/lib/security/redacted-jsonl-transcript";
import type { z } from "zod";
import { MAIN_FILE_KEY } from "@/app/agent-sessions/transcript-availability";
import { transcriptReadService } from "@/app/agent-sessions/transcript-read-service";
import { transcriptSyncService } from "@/app/desktop/transcripts/service";
import type { VibeSeedContext } from "../stage";
import {
  type DesktopSyncTarget,
  resolveDesktopSyncTargets,
} from "./sync-target";

/**
 * ISS-12017: the transcript archive lane for every ingested session, through
 * `transcriptSyncService`, the service behind `/desktop/transcripts/*`.
 *
 * With `TRANSCRIPTS_BUCKET` configured (the vibe environment points it at its
 * local object store), each session's main transcript is uploaded exactly as a
 * signed-in Desktop uploads it: the golden corpus file's complete lines,
 * redacted by the shared JSONL redactor, planned with `sync-plan`, PUT to the
 * presigned URL, and finalized with `complete`. The stage then reads one
 * transcript back through the service behind
 * `GET /agent-sessions/[id]/transcript` and fetches its presigned URL.
 *
 * Without a bucket, a signed-in Desktop's `sync-plan` answers 503
 * `upstream_not_configured` while `skip` answers 200, so its lane gives up each
 * file with `environment_unavailable` (`docs/desktop-sync/transcript-lane.md`,
 * "Terminal skip reasons"); the stage replays that terminal state instead.
 */

export const DESKTOP_TRANSCRIPTS_STAGE = "desktop-transcripts";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const GOLDEN_CORPUS_DIR = join(REPO_ROOT, "packages", "golden-sessions");

export type IngestedSession = {
  readonly artifactId: string;
  readonly externalSessionId: string;
  readonly harness: string;
  readonly lastActivityAt: Date;
};

export type UploadedTranscript = {
  readonly artifactId: string;
  readonly sha256Hex: string;
  /** The archive already held these bytes, so `sync-plan` answered `noop`. */
  readonly unchanged: boolean;
};

export async function syncGoldenTranscripts(
  context: VibeSeedContext
): Promise<void> {
  const targets = await resolveDesktopSyncTargets(
    context,
    DESKTOP_TRANSCRIPTS_STAGE
  );
  if (awsStorageConfig.TRANSCRIPTS_BUCKET === undefined) {
    let skipped = 0;
    for (const target of targets) {
      for (const session of await readIngestedSessions(target)) {
        await skipMainTranscript(target, session);
        skipped += 1;
      }
    }
    context.log(
      `transcript lane: ${skipped} main transcript(s) settled as ${TranscriptSkipReason.EnvironmentUnavailable}`
    );
    return;
  }
  const uploaded: {
    target: DesktopSyncTarget;
    transcript: UploadedTranscript;
  }[] = [];
  const unsourced: string[] = [];
  for (const target of targets) {
    const lane = await uploadGoldenTranscripts(
      target,
      await readIngestedSessions(target),
      readCorpusTimeMap(target)
    );
    uploaded.push(
      ...lane.uploaded.map((transcript) => ({ target, transcript }))
    );
    unsourced.push(...lane.unsourced);
  }
  const [proof] = uploaded;
  if (proof === undefined) {
    throw new Error(
      `no ingested session has a main transcript in the golden corpus at ${GOLDEN_CORPUS_DIR}`
    );
  }
  context.log(
    `transcript lane: ${uploaded.length} main transcript(s) archived (${uploaded.filter(({ transcript }) => transcript.unchanged).length} already held) across ${targets.length} machine(s); no corpus JSONL for ${unsourced.length}: ${unsourced.join(", ") || "none"}`
  );
  await proveTranscriptReadable(proof.target, proof.transcript);
}

/**
 * The golden corpus file holding a session's main transcript: Claude names it
 * `<id>.jsonl`, Codex `rollout-<stamp>-<id>.jsonl`. Null when the dossier has
 * no JSONL main transcript (OpenCode keeps its sessions in `opencode.db`).
 */
export function findMainTranscriptSource(
  corpusDir: string,
  externalSessionId: string
): string | null {
  const rawDir = join(corpusDir, externalSessionId, "raw");
  if (!existsSync(rawDir)) {
    return null;
  }
  const match = pickVibeCorpusMainTranscript(
    readdirSync(rawDir),
    externalSessionId
  );
  return match === null ? null : join(rawDir, match);
}

async function readIngestedSessions(
  target: DesktopSyncTarget
): Promise<IngestedSession[]> {
  const sessions = await withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        computeTargetId: target.computeTargetId,
        artifact: { organizationId: target.organizationId },
      },
      orderBy: { externalSessionId: "asc" },
      select: {
        artifactId: true,
        externalSessionId: true,
        harness: true,
        lastActivityAt: true,
      },
    })
  );
  if (sessions.length === 0) {
    throw new Error("no ingested session to replay the transcript lane for");
  }
  return sessions;
}

async function uploadGoldenTranscripts(
  target: DesktopSyncTarget,
  sessions: readonly IngestedSession[],
  timeMap: VibeCorpusTimeMap
): Promise<{ uploaded: UploadedTranscript[]; unsourced: string[] }> {
  const uploaded: UploadedTranscript[] = [];
  const unsourced: string[] = [];
  for (const session of sessions) {
    const sourcePath = findMainTranscriptSource(
      GOLDEN_CORPUS_DIR,
      session.externalSessionId
    );
    if (sourcePath === null) {
      unsourced.push(session.externalSessionId);
      continue;
    }
    uploaded.push(
      await uploadMainTranscript(target, session, sourcePath, timeMap)
    );
  }
  return { uploaded, unsourced };
}

async function uploadMainTranscript(
  target: DesktopSyncTarget,
  session: IngestedSession,
  sourcePath: string,
  timeMap: VibeCorpusTimeMap
): Promise<UploadedTranscript> {
  // ISS-12135: the transcript reads as the Acme work the vibe store holds, on
  // the clock the store build moved the session's own row to.
  return await archiveMainTranscript(
    target,
    session,
    vibeCorpusTranscriptText(readFileSync(sourcePath, "utf8"), timeMap),
    sha256Hex(relative(REPO_ROOT, sourcePath))
  );
}

/**
 * Archives one session's main transcript as a signed-in Desktop does: the
 * complete JSONL lines, redacted, planned with `sync-plan`, PUT to the
 * presigned URL and finalized with `complete`.
 */
export async function archiveMainTranscript(
  target: DesktopSyncTarget,
  session: IngestedSession,
  jsonl: string,
  sourcePathHash: string
): Promise<UploadedTranscript> {
  const bytes = await redactCompleteLines(Buffer.from(jsonl));
  const checksums = await transcriptObjectChecksums(bytes);
  const identity = {
    computeTargetId: target.computeTargetId,
    externalSessionId: session.externalSessionId,
    fileKey: MAIN_FILE_KEY,
  };
  const deps = { now: () => target.now.getTime() };
  const plan = await transcriptSyncService.planSync({
    ...principal(target),
    request: parseRequest(transcriptSyncPlanRequestSchema, session, {
      ...identity,
      sourceHarness: session.harness,
      sourcePathHash,
      planEndOffset: checksums.byteLength,
      sha256: checksums.sha256Hex,
      crc64nvme: checksums.crc64NvmeBase64,
      sourceMtime: session.lastActivityAt.toISOString(),
    }),
    deps,
  });
  if (!plan.ok) {
    throw new Error(
      `transcript sync-plan refused for ${session.externalSessionId}: ${plan.error}`
    );
  }
  const uploaded = {
    artifactId: session.artifactId,
    sha256Hex: checksums.sha256Hex,
  };
  if (plan.value.mode === "noop") {
    return { ...uploaded, unchanged: true };
  }
  if (plan.value.mode === "multipart") {
    throw new Error(
      `transcript sync-plan for ${session.externalSessionId} asked for a multipart upload of ${checksums.byteLength} bytes; the seed only performs single-part uploads`
    );
  }
  await putTranscript(plan.value.url, bytes, checksums, session);
  const completed = await transcriptSyncService.complete({
    ...principal(target),
    request: parseRequest(transcriptCompleteRequestSchema, session, {
      ...identity,
      mode: plan.value.mode,
      planEndOffset: checksums.byteLength,
      sha256: checksums.sha256Hex,
      crc64nvme: checksums.crc64NvmeBase64,
    }),
    deps,
  });
  if (!completed.ok) {
    throw new Error(
      `transcript complete refused for ${session.externalSessionId}: ${completed.error}`
    );
  }
  if (completed.value.status !== TranscriptUploadStatus.Uploaded) {
    throw new Error(
      `transcript complete for ${session.externalSessionId} settled as ${completed.value.status}`
    );
  }
  return { ...uploaded, unchanged: false };
}

/** The PUT a Desktop makes for a `fullPut` plan (`desktop-transcripts-client.ts`). */
async function putTranscript(
  url: string,
  bytes: Uint8Array<ArrayBuffer>,
  checksums: TranscriptObjectChecksums,
  session: IngestedSession
): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    body: bytes,
    headers: {
      "Content-Type": TRANSCRIPT_CONTENT_TYPE,
      [S3_CHECKSUM_CRC64NVME_HEADER]: checksums.crc64NvmeBase64,
    },
  });
  if (!response.ok) {
    throw new Error(
      `transcript PUT for ${session.externalSessionId} answered ${response.status}: ${await response.text()}`
    );
  }
}

/**
 * Reads one uploaded transcript back the way the session detail does: the
 * descriptor from the read service, then its presigned URL, and checks the
 * bytes that come back are the bytes uploaded.
 */
async function proveTranscriptReadable(
  target: DesktopSyncTarget,
  transcript: UploadedTranscript
): Promise<void> {
  const access = await transcriptReadService.findTranscriptAccess({
    id: transcript.artifactId,
    organizationId: target.organizationId,
  });
  const main = access?.files.find((file) => file.fileKey === MAIN_FILE_KEY);
  if (!main?.url) {
    throw new Error(
      `session ${transcript.artifactId}'s main transcript has no signed URL (availability: ${main?.availability ?? "no descriptor"})`
    );
  }
  const response = await fetch(main.url);
  if (!response.ok) {
    throw new Error(
      `session ${transcript.artifactId}'s presigned transcript URL answered ${response.status}`
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (sha256Hex(body) !== transcript.sha256Hex) {
    throw new Error(
      `session ${transcript.artifactId}'s presigned transcript URL served bytes that differ from the upload`
    );
  }
  target.log(
    `transcript read path: session ${transcript.artifactId} served ${body.byteLength} bytes through its presigned URL`
  );
}

export async function skipMainTranscript(
  target: DesktopSyncTarget,
  session: IngestedSession
): Promise<void> {
  const result = await transcriptSyncService.markPermanentlySkipped({
    ...principal(target),
    request: parseRequest(transcriptSkipRequestSchema, session, {
      computeTargetId: target.computeTargetId,
      externalSessionId: session.externalSessionId,
      fileKey: MAIN_FILE_KEY,
      sourceHarness: session.harness,
      reason: TranscriptSkipReason.EnvironmentUnavailable,
    }),
  });
  if (!result.ok) {
    throw new Error(
      `transcript skip refused for ${session.externalSessionId}: ${result.error}`
    );
  }
}

/** The complete JSONL lines of a source file, redacted as the Desktop archives them. */
async function redactCompleteLines(
  raw: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of redactJsonlTranscriptByteChunks([raw])) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseRequest<T extends z.ZodType>(
  schema: T,
  session: IngestedSession,
  request: z.input<T>
): z.output<T> {
  const parsed = schema.safeParse(request);
  if (!parsed.success) {
    throw new Error(
      `transcript request for ${session.externalSessionId} fails the route schema: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

function principal(target: DesktopSyncTarget) {
  return {
    organizationId: target.organizationId,
    userId: target.userId,
    clerkUserId: target.clerkUserId,
  };
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The time map the store build applied, recorded beside the store, plus the
 * shift this run adds to every row it reads from that store
 * (`target.shift`, nonzero when the store was prepared at another `now`), so a
 * transcript lands on the same clock as its session row.
 */
function readCorpusTimeMap(target: DesktopSyncTarget): VibeCorpusTimeMap {
  const mapPath = vibeCorpusTimeMapPath(target.storePath);
  if (!existsSync(mapPath)) {
    throw new Error(
      `the vibe store at ${target.storePath} has no time map at ${mapPath}; rebuild it with the vibe profile's build-store`
    );
  }
  const built = vibeCorpusTimeMapSchema.parse(
    JSON.parse(readFileSync(mapPath, "utf8"))
  );
  return { ...built, shiftMs: built.shiftMs + target.shift.shiftMs };
}
