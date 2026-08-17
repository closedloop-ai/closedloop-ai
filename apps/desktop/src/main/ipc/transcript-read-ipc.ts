/**
 * Main-process half of the desktop cloud-transcript read bridge (FEA-3324
 * Option B2 / PLN-1138 Phase 2).
 *
 * The renderer asks to *prepare* a transcript file by (sessionId, fileKey); this
 * handler authorizes and mints the signed S3 URL itself by calling the read
 * route with the first-party desktop session token, streams the bytes into the
 * local {@link ensureTranscriptCached} cache, and returns an opaque same-origin
 * `app://renderer/transcripts/…` URL. The renderer never supplies a URL (SSRF
 * prevention) and never sees the credential; the transcript bytes never cross
 * IPC — only the small prepare-result envelope does.
 *
 * Security properties mirror the cloud-API fetch bridge (`cloud-api-fetch-ipc`):
 * untrusted senders reject; the target origin is resolved here and re-asserted
 * after URL composition; the `Authorization` and org-identity headers are
 * injected here from the session manager; signed-out short-circuits without
 * touching the network.
 */

import { transcriptAccessResponseSchema } from "@repo/api/src/types/desktop-transcripts";
import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";
import {
  TRANSCRIPT_CANCEL_CHANNEL,
  TRANSCRIPT_PREPARE_CHANNEL,
  type TranscriptCancelRequest,
  type TranscriptPrepareRequest,
  type TranscriptPrepareResult,
} from "../../shared/transcript-read-contract.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  buildTranscriptAppUrl,
  DEFAULT_TRANSCRIPT_CACHE_MAX_AGE_MS,
  DEFAULT_TRANSCRIPT_CACHE_MAX_TOTAL_BYTES,
  ensureTranscriptCached,
  evictTranscriptCache,
  isValidRawSha256,
  stageLocalTranscript,
  statLocalTranscriptSize,
} from "../transcript/transcript-read-cache.js";

/** Upper bound on the read-route (descriptor) call. */
const ACCESS_TIMEOUT_MS = 30_000;
/** Upper bound on the (potentially large) S3 byte download. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Compose a per-download-site abort signal (FEA-3678): a FRESH
 * `AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)` combined with the shared
 * renderer-cancel `cancelSignal`, so every byte download gets its own timeout
 * budget while a user Cancel still aborts whatever transfer is in flight. Built
 * per-site rather than shared across the cloud attempt and the local fallback:
 * a single combined signal would stay permanently aborted once the cloud
 * download's timeout fires, poisoning the local `.jsonl` fallback into an
 * instant abort instead of letting it degrade gracefully.
 */
function buildDownloadSignal(cancelSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    cancelSignal,
  ]);
}

/**
 * Field validators for the renderer-supplied prepare request, kept as a
 * standalone literal so the keys-covered guard can see them.
 *
 * `satisfies Record<keyof TranscriptPrepareRequest, z.ZodTypeAny>` is the
 * compile-time guard the `z.ZodType<TranscriptPrepareRequest>` annotation alone
 * does NOT provide: zod's `ZodType` is covariant in its output, so a schema that
 * omits an optional key still satisfies that annotation. Because the schema is
 * `.strict()`, a field added to {@link TranscriptPrepareRequest} and sent by the
 * renderer without being taught here would make main reject the ENTIRE prepare
 * request as malformed — every transcript open failing at once (the FEA-3701
 * lesson in the root AGENTS.md, and the same guard the sibling
 * `cloud-api-fetch-ipc` bridge carries).
 *
 * Scope: this proves KEY COVERAGE only. `z.ZodTypeAny` is the top type, so it
 * does NOT pin a key's bounds or its optionality — relaxing a `.min(1)` or
 * dropping an `.optional()` on an already-covered key still satisfies it. Treat
 * a passing guard as "no key was forgotten", never as sign-off on a validator
 * change.
 */
const transcriptPrepareRequestShape = {
  sessionId: z.string().min(1),
  // Harness session id used ONLY to select the local candidate (never to
  // compose a path directly — the candidate is re-anchored through the
  // trusted-path guard). Optional: absent ⇒ no local fallback is attempted.
  externalSessionId: z.string().min(1).optional(),
  fileKey: z.string().min(1),
  // Positive, finite byte cap for the LOCAL oversize gate; anything else is
  // ignored (gate disabled) rather than trusted as a bound.
  maxAutoLoadBytes: z.number().int().positive().optional(),
  allowOversized: z.boolean().optional(),
  // Correlation id used only to register/cancel this download's AbortController
  // (FEA-3678). Never used to compose a path or reach the network.
  requestId: z.string().min(1).optional(),
} satisfies Record<keyof TranscriptPrepareRequest, z.ZodTypeAny>;

const transcriptPrepareRequestSchema: z.ZodType<TranscriptPrepareRequest> = z
  .object(transcriptPrepareRequestShape)
  .strict();

/** Keys-covered guard for the cancel request; see the prepare shape above. */
const transcriptCancelRequestShape = {
  requestId: z.string().min(1),
} satisfies Record<keyof TranscriptCancelRequest, z.ZodTypeAny>;

const transcriptCancelRequestSchema: z.ZodType<TranscriptCancelRequest> = z
  .object(transcriptCancelRequestShape)
  .strict();

export type TranscriptReadDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: WebContents) => boolean;
  /** Current desktop session access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Signed-in identity for the org-identity header, or null. */
  getIdentity: () => { userId: string; organizationId: string } | null;
  /** Configured cloud API origin; may throw when unset/invalid. */
  resolveApiOrigin: () => string;
  /** `userData`-rooted transcript cache directory. */
  cacheDir: string;
  /**
   * TRUSTED server-side lookup of the local transcript file for a
   * `(externalSessionId, fileKey)` — the durable transcript-sync fingerprint
   * store's `sourcePath` (falling back to a fresh collector-root discovery). The
   * key is the HARNESS `externalSessionId`, NOT the cloud `sessionId`: the local
   * store/discovery index on-disk identity, so passing the cloud id here would
   * never match. Returns null when there is no locally-tracked copy (or the sync
   * lane is disabled). Never accepts a renderer-supplied path; the path it
   * returns is still re-anchored via {@link resolveTrustedTranscriptPath} before
   * a byte is read. Absence disables the local fallback (web has no local file).
   */
  getLocalTranscriptPath?: (
    externalSessionId: string,
    fileKey: string
  ) => Promise<string | null>;
  /**
   * Re-anchor a candidate local path to its canonical real path under the known
   * transcript root, or null to refuse (SSRF/traversal guard). The SAME resolver
   * the sync service uses (`resolveTrustedClaudeTranscriptPath`). Required for
   * the local fallback to be attempted at all; without it no local read happens.
   */
  resolveTrustedTranscriptPath?: (candidate: string) => string | null;
  /** Test seam; defaults to the platform fetch (used for both the read route and S3). */
  fetchImpl?: typeof fetch;
  /** Test seam for cache eviction timestamps; defaults to `Date.now`. */
  now?: () => number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
};

type IpcMainLike = {
  handle: (
    channel:
      | typeof TRANSCRIPT_PREPARE_CHANNEL
      | typeof TRANSCRIPT_CANCEL_CHANNEL,
    listener: (
      event: IpcMainInvokeEvent,
      request: unknown
    ) => Promise<TranscriptPrepareResult> | Promise<void>
  ) => void;
};

function errorResult(message: string): TranscriptPrepareResult {
  return { kind: "error", message };
}

/**
 * Best-effort cache sweep applied to the userData transcript cache after a copy
 * is staged into it — enforces the 512 MB total / age bounds so the cache never
 * grows unbounded. Runs after BOTH a cloud download AND a local-fallback staging
 * (a locally-staged `.jsonl` is a cache entry just like a downloaded one, so it
 * must be subject to the same bounds — otherwise repeated cloud failures across
 * many/large sessions would let the cache balloon with local copies). Never
 * throws: `evictTranscriptCache` swallows per-file errors, and this guard covers
 * a readdir/stat failure on the cache dir, so a sweep failure never fails the
 * prepare.
 */
async function sweepTranscriptCache(
  deps: TranscriptReadDeps,
  protectedSha256?: string
): Promise<void> {
  try {
    await evictTranscriptCache({
      cacheDir: deps.cacheDir,
      maxTotalBytes:
        deps.maxTotalBytes ?? DEFAULT_TRANSCRIPT_CACHE_MAX_TOTAL_BYTES,
      maxAgeMs: deps.maxAgeMs ?? DEFAULT_TRANSCRIPT_CACHE_MAX_AGE_MS,
      now: (deps.now ?? Date.now)(),
      // Never evict the entry this prepare just downloaded/staged — it is about
      // to hand the renderer an `app://` URL for it (FEA-3624).
      ...(protectedSha256 ? { protectedSha256 } : {}),
    });
  } catch (error) {
    gatewayLog.warn(
      "transcript-cache",
      `eviction sweep failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Attempt to serve the LOCAL transcript for `(sessionId, fileKey)` when the
 * cloud read failed or the file was not cloud-readable. Returns a `ready` result
 * flagged `source: "local"` on success, or null when there is no usable local
 * copy — in which case the caller falls back to the original cloud error.
 *
 * SECURITY — this is the SSRF/path-safety pivot of the whole handler, so the
 * local path is treated as untrusted end-to-end:
 *  1. The candidate comes ONLY from the trusted server-side sync store
 *     (`getLocalTranscriptPath`), never from the renderer request.
 *  2. It is re-anchored through the SAME `resolveTrustedTranscriptPath`
 *     (`resolveTrustedClaudeTranscriptPath`) the sync service uses — resolving
 *     symlinks and refusing anything outside the known transcript root or that
 *     is not a real `.jsonl` file. Only the returned canonical real path is read.
 *  3. `stageLocalTranscript` streams that vetted path into the content-addressed
 *     cache and hands back the same opaque `app://` URL the cloud path returns —
 *     the renderer contract is byte-for-byte identical (no renderer-supplied URL,
 *     same-origin, streamed).
 *
 * OVERSIZE GATE — the cloud descriptor carries `byteSize` so the renderer gates
 * large cloud files before ever calling prepare, but a local file the cloud
 * can't see has no upfront size. So we `stat` the vetted path (O(1)) and, when
 * it exceeds the request's `maxAutoLoadBytes` and the user hasn't opted in
 * (`allowOversized`), return an `oversized` envelope WITHOUT staging the bytes —
 * the renderer then shows the same explicit "Load full transcript" gate, and a
 * 275 MB outlier is never streamed/parsed until the user asks.
 */
async function tryLocalFallback(
  deps: TranscriptReadDeps,
  request: TranscriptPrepareRequest,
  cancelSignal: AbortSignal
): Promise<TranscriptPrepareResult | null> {
  const { getLocalTranscriptPath, resolveTrustedTranscriptPath } = deps;
  if (!(getLocalTranscriptPath && resolveTrustedTranscriptPath)) {
    return null;
  }
  // Key the local lookup by the HARNESS externalSessionId (the on-disk identity
  // the sync store / discovery index by), NOT the cloud `sessionId`. Absent ⇒
  // the caller cannot identify a local file, so there is no fallback to attempt.
  const { externalSessionId } = request;
  if (!externalSessionId) {
    return null;
  }
  let candidate: string | null;
  try {
    candidate = await getLocalTranscriptPath(
      externalSessionId,
      request.fileKey
    );
  } catch {
    return null;
  }
  if (!candidate) {
    return null;
  }
  // Re-anchor: refuse unless the path resolves (following symlinks) to a real
  // `.jsonl` under the trusted transcript root.
  const trustedPath = resolveTrustedTranscriptPath(candidate);
  if (!trustedPath) {
    gatewayLog.warn(
      "transcript-read",
      "local fallback refused: path failed the trusted-transcript-root check"
    );
    return null;
  }
  // Oversize gate BEFORE staging: stat the vetted file and, if it is over the
  // renderer's cap and the user hasn't opted in, return the size so the renderer
  // shows the explicit-load gate — without streaming the bytes.
  const { maxAutoLoadBytes, allowOversized } = request;
  if (maxAutoLoadBytes != null && !allowOversized) {
    const byteSize = statLocalTranscriptSize(trustedPath);
    if (byteSize != null && byteSize > maxAutoLoadBytes) {
      return { kind: "oversized", byteSize, source: "local" };
    }
  }
  try {
    const { url, rawSha256 } = await stageLocalTranscript({
      cacheDir: deps.cacheDir,
      sourcePath: trustedPath,
      // Fresh per-site timeout + renderer-cancel signal (FEA-3678), so a user
      // Cancel also aborts a local-fallback stage mid-copy — and a cloud
      // download that already timed out does NOT poison this fallback.
      signal: buildDownloadSignal(cancelSignal),
      // Same clock the subsequent sweep uses, so a cache-hit mtime refresh here
      // stays consistent with the eviction pass under an injected test clock.
      now: (deps.now ?? Date.now)(),
    });
    // The staged local copy is a cache entry too — subject it to the same
    // bounds the cloud download path enforces (else the cache grows unbounded
    // with local copies when cloud reads keep failing) — but never evict the
    // copy we just staged and are about to return a URL for (FEA-3624).
    await sweepTranscriptCache(deps, rawSha256);
    return { kind: "ready", url, source: "local" };
  } catch (error) {
    gatewayLog.warn(
      "transcript-read",
      `local fallback staging failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Serve the local copy if there is one, else return the given cloud error
 * unchanged. Every cloud-read failure point routes through here so the panel
 * "deteriorates gracefully" to local bytes instead of a dead state.
 */
async function cloudFailureOrLocal(
  deps: TranscriptReadDeps,
  request: TranscriptPrepareRequest,
  cloudError: TranscriptPrepareResult,
  cancelSignal: AbortSignal
): Promise<TranscriptPrepareResult> {
  const local = await tryLocalFallback(deps, request, cancelSignal);
  return local ?? cloudError;
}

/**
 * Call `GET /agent-sessions/{id}/transcript` with the first-party token and
 * return the validated descriptor. Throws on a non-2xx or a malformed body so
 * the handler maps it to a single `error` envelope.
 */
async function fetchTranscriptAccess(
  deps: TranscriptReadDeps,
  sessionId: string,
  token: string
): Promise<z.infer<typeof transcriptAccessResponseSchema>> {
  const origin = deps.resolveApiOrigin();
  const originUrl = new URL(origin);
  const url = new URL(
    `/agent-sessions/${encodeURIComponent(sessionId)}/transcript`,
    origin
  );
  // Re-assert composition stayed on the configured origin (defense in depth;
  // sessionId is encoded, but keep the invariant explicit).
  if (url.origin !== originUrl.origin) {
    throw new Error("transcript access URL escaped the configured API origin");
  }

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const identity = deps.getIdentity();
  if (identity) {
    headers.set(ORG_IDENTITY_HEADER, identity.organizationId);
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`transcript access failed (HTTP ${response.status})`);
  }
  const parsed = transcriptAccessResponseSchema.safeParse(
    await response.json()
  );
  if (!parsed.success) {
    throw new Error("transcript access response was malformed");
  }
  return parsed.data;
}

/**
 * Run the cloud-preferred prepare with the renderer-cancel `cancelSignal`
 * (FEA-3678). Each byte-download site — the cloud stream AND any local-fallback
 * stage — composes its OWN timeout with this shared cancel signal (via
 * {@link buildDownloadSignal}), so a user Cancel aborts the in-flight transfer
 * mid-stream while a cloud-download timeout can't poison a subsequent local
 * fallback. Extracted from {@link prepareTranscript} so the latter owns only the
 * request parse + `AbortController` lifecycle.
 */
async function runPrepare(
  deps: TranscriptReadDeps,
  request: TranscriptPrepareRequest,
  cancelSignal: AbortSignal
): Promise<TranscriptPrepareResult> {
  const { sessionId, fileKey } = request;

  // Cloud is PREFERRED; on ANY cloud-read failure below we fall back to the
  // local `.jsonl` (via `cloudFailureOrLocal`) so the panel shows what we have
  // on disk instead of a dead/empty state ("deteriorate gracefully"). The local
  // path is resolved from trusted server-side state and re-anchored to the
  // transcript root inside `tryLocalFallback` — never from the renderer.

  const token = await deps.getAccessToken();
  if (!token) {
    // Signed out: no way to reach the cloud copy, but a local copy needs no
    // auth — serve it if present.
    return cloudFailureOrLocal(
      deps,
      request,
      errorResult("Desktop is not signed in."),
      cancelSignal
    );
  }

  let access: z.infer<typeof transcriptAccessResponseSchema>;
  try {
    access = await fetchTranscriptAccess(deps, sessionId, token);
  } catch (error) {
    return cloudFailureOrLocal(
      deps,
      request,
      errorResult(
        error instanceof Error
          ? error.message
          : "Failed to authorize transcript."
      ),
      cancelSignal
    );
  }

  const file = access.files.find((entry) => entry.fileKey === fileKey);
  if (!file) {
    return cloudFailureOrLocal(
      deps,
      request,
      errorResult("Transcript file not found."),
      cancelSignal
    );
  }
  // `url`/`rawSha256` are non-null only for readable (available/stale) files;
  // the renderer already gates on readability, but re-check on the authoritative
  // descriptor rather than trusting the caller. When the cloud copy is not yet
  // readable (the likely case for a freshly-run local session), fall back to the
  // local file rather than showing "not available for reading".
  if (!(file.url && file.rawSha256 && isValidRawSha256(file.rawSha256))) {
    return cloudFailureOrLocal(
      deps,
      request,
      errorResult("Transcript is not available for reading."),
      cancelSignal
    );
  }

  try {
    await ensureTranscriptCached({
      cacheDir: deps.cacheDir,
      rawSha256: file.rawSha256,
      signedUrl: file.url,
      fetchImpl: deps.fetchImpl ?? fetch,
      // Fresh per-site timeout + renderer-cancel signal (FEA-3678): a user
      // Cancel aborts this S3 download mid-stream so the egress stops, and this
      // site gets its own 120s upper bound via `buildDownloadSignal`.
      signal: buildDownloadSignal(cancelSignal),
      // Drive the cache-hit mtime bump off the same clock source the sweep uses,
      // so an injected test clock keeps the bump and the eviction that follows
      // consistent (with the real clock the sub-ms difference is immaterial).
      now: (deps.now ?? Date.now)(),
    });
  } catch (error) {
    return cloudFailureOrLocal(
      deps,
      request,
      errorResult(
        error instanceof Error
          ? error.message
          : "Failed to download transcript."
      ),
      cancelSignal
    );
  }

  // Best-effort cache sweep — runs after the (already-awaited) download, and
  // never fails the prepare. Protect the entry we just downloaded so the sweep
  // can't evict the file the URL below points at (FEA-3624).
  await sweepTranscriptCache(deps, file.rawSha256);

  return {
    kind: "ready",
    url: buildTranscriptAppUrl(file.rawSha256),
    source: "cloud",
  };
}

/**
 * Registry of the AbortControllers for in-flight prepares, keyed by the
 * request's `requestId` (FEA-3678). Populated for the duration of a prepare and
 * dropped in its `finally`; the cancel handler aborts the matching entry so the
 * main-process download stops mid-stream. One map per handler registration.
 */
type PrepareRegistry = Map<string, AbortController>;

async function prepareTranscript(
  deps: TranscriptReadDeps,
  rawRequest: unknown,
  registry: PrepareRegistry
): Promise<TranscriptPrepareResult> {
  const parsed = transcriptPrepareRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    return errorResult("Malformed transcript request.");
  }
  const request = parsed.data;

  // A renderer-triggered cancel signal (FEA-3678), shared across every byte
  // download; each download site composes it with its OWN fresh timeout via
  // `buildDownloadSignal`. The controller is registered under `requestId` so the
  // cancel channel can abort THIS request's in-flight download; absent a
  // `requestId` (older/web callers) the download is timeout-bounded only,
  // exactly as before.
  const controller = new AbortController();
  const { requestId } = request;
  if (requestId) {
    registry.set(requestId, controller);
  }
  try {
    return await runPrepare(deps, request, controller.signal);
  } finally {
    if (requestId) {
      registry.delete(requestId);
    }
  }
}

/**
 * Abort the in-flight download for a cancel request's `requestId` (FEA-3678).
 * Best-effort and idempotent: a malformed request, or a `requestId` with no live
 * download (already finished / never registered / another window's), is a no-op.
 */
function cancelTranscriptPrepare(
  registry: PrepareRegistry,
  rawRequest: unknown
): void {
  const parsed = transcriptCancelRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    return;
  }
  registry.get(parsed.data.requestId)?.abort();
}

/**
 * Registers the transcript-prepare + cancel handlers. Untrusted senders reject
 * (matching the rest of the desktop IPC surface); every other prepare failure
 * mode returns a typed `error` envelope the renderer surfaces like any transcript
 * read error. The cancel handler (FEA-3678) aborts the matching in-flight
 * download so the main-process S3 transfer stops when the user clicks Cancel,
 * instead of running to completion and wasting egress.
 */
export function registerTranscriptReadIpcHandler(
  ipcMain: IpcMainLike,
  deps: TranscriptReadDeps
): void {
  const registry: PrepareRegistry = new Map();
  ipcMain.handle(
    TRANSCRIPT_PREPARE_CHANNEL,
    (event, request): Promise<TranscriptPrepareResult> => {
      if (!deps.isTrustedSender(event.sender)) {
        throw new Error("untrusted sender");
      }
      return prepareTranscript(deps, request, registry);
    }
  );
  ipcMain.handle(TRANSCRIPT_CANCEL_CHANNEL, (event, request): Promise<void> => {
    if (!deps.isTrustedSender(event.sender)) {
      throw new Error("untrusted sender");
    }
    cancelTranscriptPrepare(registry, request);
    return Promise.resolve();
  });
}
