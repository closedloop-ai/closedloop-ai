/**
 * @file transcript-lane-give-up-harness.ts
 * @description ISS-9884: one transcript archive lane over a REAL libSQL store,
 * driven by a movable clock against a stub cloud whose answers a case can change
 * mid-run — shared by the give-up and recovery-door suites.
 *
 * Real wherever the give-up's behaviour is decided: the store (the revival, the
 * durable `sync_state` stamp, every settle), the control client (so each failure
 * the drain classifies is a real `TranscriptSyncClientError`), the drain and the
 * service. A stateful fake of either half would decide the answer under test
 * itself. The executor is a fake only in what it SKIPS — reading bytes off disk
 * — and hands its upload settle to the same batch collector production uses.
 * Its terminal skip is the production `notifyPermanentSkip`: the double it
 * replaced sent every skip under `ct-1` whatever it was asked, so it could not
 * observe which target a pause was acknowledged under, or whether one was sent.
 */
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import type { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import type { DesktopPrisma } from "../../src/main/database/prisma-client.js";
import type { TranscriptSettle } from "../../src/main/database/transcript-sync-settle.js";
import {
  createTranscriptSyncStore,
  type TranscriptSyncStore,
} from "../../src/main/database/transcript-sync-store.js";
import { createDesktopTranscriptsClient } from "../../src/main/transcript/desktop-transcripts-client.js";
import { buildTranscriptSyncSourceKey } from "../../src/main/transcript-sync/transcript-lane-give-up.js";
import {
  createTranscriptSyncExecutor,
  type TranscriptSyncExecutor,
} from "../../src/main/transcript-sync/transcript-sync-executor.js";
import type { TranscriptSyncService } from "../../src/main/transcript-sync/transcript-sync-service.js";
import type { TranscriptFingerprint } from "../../src/main/transcript-sync/transcript-sync-types.js";
import { openTestPrisma } from "../prisma-test-utils.js";
import { fakeScheduler, makeService } from "./transcript-sync-fixtures.js";
import { observeInput } from "./transcript-sync-store-fixtures.js";

export const START_MS = Date.parse("2026-07-09T00:00:00.000Z");
export const MINUTE_MS = 60_000;
export const COMPUTE_TARGET = "ct-1";
export const SYNC_PLAN_PATH = "/desktop/transcripts/sync-plan";
export const SKIP_PATH = "/desktop/transcripts/skip";
/** The offset a healthy plan reports holding, i.e. the transcript uploaded. */
export const UPLOADED_OFFSET = 500;

/** How the stub cloud answers right now. A case may change it mid-run. */
export const CloudMode = {
  /** 401 on every control route, the skip included — nothing can ack. */
  Unauthorized: "unauthorized",
  /** 503 on the plan while the skip answers: `TRANSCRIPTS_BUCKET` unset. */
  BucketUnset: "bucketUnset",
  /** 409 on the plan — an answer judged against the row. */
  Conflict: "conflict",
  /** The plan answers `noop` at the file's end: the transcript uploads. */
  Healthy: "healthy",
} as const;
export type CloudMode = (typeof CloudMode)[keyof typeof CloudMode];

export type ControlPost = {
  path: string;
  atMs: number;
  externalSessionId: string | null;
  /** The target the request body names — what the cloud was told, not the live one. */
  computeTargetId: string | null;
};

export type LaneHarness = {
  prisma: DesktopPrisma;
  store: TranscriptSyncStore;
  clock: { ms: number };
  cloud: {
    mode: CloudMode;
    /**
     * What the skip route says it RECORDED. Fixed by the case and never the
     * requested reason echoed back, so a caller persisting the request instead
     * of the answer is distinguishable.
     */
    recordedSkipReason: TranscriptSkipReason | null;
    /**
     * The terminal status the skip route answers with. `Uploaded` is the cloud
     * refusing the skip because it already holds a verified archive.
     */
    skipStatus: TranscriptUploadStatus;
    /** Awaited before a session's plan is sent, so a case can order failures. */
    beforePlan: Map<string, Promise<void>>;
    /** Called as a session's plan request reaches the cloud, mid-attempt. */
    onPlan: (externalSessionId: string | null) => void;
    /** Called once the skip route has answered for a session. */
    onSkip: (externalSessionId: string | null) => void;
  };
  target: { id: string | null };
  posts: ControlPost[];
  logs: string[];
  /** The live service — replaced by {@link LaneHarness.relaunch}. */
  service: TranscriptSyncService;
  /** A new process over the same database: nothing in memory survives. */
  relaunch: () => void;
  /** Move the clock to `atMs` and run one drain pass. */
  tickAt: (atMs: number) => Promise<void>;
  /** A row mid-way through a lane-wide run that opened at `stalledSinceMs`. */
  seedStalledRow: (
    externalSessionId: string,
    stalledSinceMs: number
  ) => Promise<void>;
  /** A transcript observed now: queued and due immediately. */
  observeFresh: (externalSessionId: string) => Promise<void>;
  laneGaveUpAt: (computeTargetId?: string) => Promise<string | null>;
  /** The raw persisted column, so a NULL is told apart from a known label. */
  terminalSkipReason: (externalSessionId: string) => Promise<string | null>;
  planPostsFor: (externalSessionId: string) => ControlPost[];
};

export async function withLaneHarness(
  run: (lane: LaneHarness) => Promise<void>
): Promise<void> {
  const { prisma, close } = await openTestPrisma();
  try {
    await run(buildLaneHarness(prisma));
  } finally {
    await close();
  }
}

function buildLaneHarness(prisma: DesktopPrisma): LaneHarness {
  const store = createTranscriptSyncStore(prisma);
  const clock = { ms: START_MS };
  const nowIso = () => new Date(clock.ms).toISOString();
  const posts: ControlPost[] = [];
  const logs: string[] = [];
  const target = { id: COMPUTE_TARGET as string | null };
  const cloud: LaneHarness["cloud"] = {
    mode: CloudMode.Healthy,
    recordedSkipReason: null,
    skipStatus: TranscriptUploadStatus.Skipped,
    beforePlan: new Map(),
    onPlan: () => undefined,
    onSkip: () => undefined,
  };
  const client = createDesktopTranscriptsClient({
    fetch: (async (requestTarget: URL | string, init?: RequestInit) => {
      const url = new URL(String(requestTarget));
      const { externalSessionId, computeTargetId } = requestFields(init?.body);
      if (url.pathname === SYNC_PLAN_PATH && externalSessionId) {
        await cloud.beforePlan.get(externalSessionId);
      }
      if (url.pathname === SYNC_PLAN_PATH) {
        cloud.onPlan(externalSessionId);
      }
      posts.push({
        path: url.pathname,
        atMs: clock.ms,
        externalSessionId,
        computeTargetId,
      });
      const response = stubCloudAnswer(url.pathname, cloud);
      if (url.pathname === SKIP_PATH) {
        cloud.onSkip(externalSessionId);
      }
      return response;
    }) as unknown as typeof fetch,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.test",
  });
  const { notifyPermanentSkip } = createTranscriptSyncExecutor({
    store,
    client,
    getComputeTargetId: () => target.id,
    now: nowIso,
    log: (message) => logs.push(message),
  });
  const executor = {
    syncFile: async (
      fp: TranscriptFingerprint,
      options?: { settleCollector?: (settle: TranscriptSettle) => void }
    ) => {
      const plan = await client.syncPlan({
        computeTargetId: COMPUTE_TARGET,
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        sourceHarness: "claude",
        sourcePathHash: fp.sourcePathHash,
        sourceMtime: 1000,
        planEndOffset: UPLOADED_OFFSET,
      } as never);
      options?.settleCollector?.({
        kind: "uploaded",
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        syncedByteOffset: plan.syncedByteOffset,
        syncedSha256: null,
        storedEtag: plan.storedEtag,
        syncedComputeTargetId: COMPUTE_TARGET,
        caughtUp: true,
        now: nowIso(),
      });
      return { kind: "noop" as const };
    },
    notifyPermanentSkip,
  } as unknown as TranscriptSyncExecutor;
  const launch = () =>
    makeService({
      store: store as never,
      executor,
      scheduler: fakeScheduler().scheduler,
      getComputeTargetId: () => target.id,
      now: nowIso,
      log: (message) => logs.push(message),
    }).service;
  const observeFor = (externalSessionId: string) =>
    observeInput({
      externalSessionId,
      sourcePath: `/home/.claude/projects/p/${externalSessionId}.jsonl`,
      sourcePathHash: `hash-${externalSessionId}`,
      syncClass: "live",
      now: nowIso(),
    });
  const lane: LaneHarness = {
    prisma,
    store,
    clock,
    cloud,
    target,
    posts,
    logs,
    service: launch(),
    relaunch: () => {
      lane.service = launch();
    },
    tickAt: async (atMs) => {
      clock.ms = atMs;
      await lane.service.drainOnce();
    },
    seedStalledRow: async (externalSessionId, stalledSinceMs) => {
      await store.observe(observeFor(externalSessionId));
      await store.recordFailure({
        externalSessionId,
        fileKey: "main",
        retryCount: 0,
        missingSourceCount: 0,
        dead: false,
        nextAttemptAt: null,
        lastError: "seeded lane-wide failure",
        laneStalledSince: new Date(stalledSinceMs).toISOString(),
        terminalSkipReason: null,
        terminalSkipComputeTargetId: null,
        now: nowIso(),
      });
    },
    observeFresh: async (externalSessionId) => {
      await store.observe(observeFor(externalSessionId));
    },
    laneGaveUpAt: (computeTargetId = COMPUTE_TARGET) =>
      store.loadLaneGiveUp(buildTranscriptSyncSourceKey(computeTargetId)),
    terminalSkipReason: async (externalSessionId) => {
      const row = await prisma.client.transcriptSyncState.findUnique({
        where: {
          externalSessionId_fileKey: { externalSessionId, fileKey: "main" },
        },
        select: { terminalSkipReason: true },
      });
      return row?.terminalSkipReason ?? null;
    },
    planPostsFor: (externalSessionId) =>
      posts.filter(
        (post) =>
          post.path === SYNC_PLAN_PATH &&
          post.externalSessionId === externalSessionId
      ),
  };
  return lane;
}

function stubCloudAnswer(path: string, cloud: LaneHarness["cloud"]): Response {
  if (cloud.mode === CloudMode.Unauthorized) {
    return new Response(null, { status: 401 });
  }
  if (path === SKIP_PATH) {
    return jsonResponse({
      status: cloud.skipStatus,
      permanentFailureReason: cloud.recordedSkipReason,
      sessionDetailId: null,
    });
  }
  if (cloud.mode === CloudMode.BucketUnset) {
    return new Response("transcripts bucket is not configured", {
      status: 503,
    });
  }
  if (cloud.mode === CloudMode.Conflict) {
    return new Response("stale upload", { status: 409 });
  }
  return jsonResponse({
    mode: "noop",
    syncedByteOffset: UPLOADED_OFFSET,
    storedEtag: "etag-1",
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestFields(body: unknown): {
  externalSessionId: string | null;
  computeTargetId: string | null;
} {
  if (typeof body !== "string") {
    return { externalSessionId: null, computeTargetId: null };
  }
  const parsed = JSON.parse(body) as {
    externalSessionId?: unknown;
    computeTargetId?: unknown;
  };
  return {
    externalSessionId: stringOrNull(parsed.externalSessionId),
    computeTargetId: stringOrNull(parsed.computeTargetId),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
