/**
 * Local disk cache for cloud session transcripts (FEA-3324 Option B2).
 *
 * The main process downloads a transcript's raw JSONL from its short-lived
 * signed S3 URL, streams it into this cache under `userData`, and serves it to
 * the renderer over the `app://renderer/transcripts/…` scheme (see
 * `window.ts`). Nothing is buffered whole in main (a 275 MB outlier streams
 * straight to disk) and nothing crosses the IPC bridge — only the small
 * prepare-result envelope does.
 *
 * Cache entries are **content-addressed by `rawSha256`** (the archive identity
 * the read route returns), so they are immutable: a re-upload changes the sha,
 * writes a new file, and the old one ages out. The `rawSha256` is validated as
 * lowercase hex before it is ever used in a filesystem path or an `app://` URL,
 * which — together with the fixed `.jsonl` suffix — makes the served path
 * un-traversable by construction (no separators, no `..`).
 *
 * Every function is parameterized by an explicit `cacheDir` / `fetchImpl` /
 * `now` so the module is exercised in tests without Electron's `app`.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { validateOutboundUrlForSurface } from "../../server/outbound-url-policy.js";

/** Subdirectory of `userData` that holds cached transcript files. */
const CACHE_DIR_NAME = "transcript-cache";

/** `app://renderer` path prefix under which prepared transcripts are served. */
export const TRANSCRIPT_APP_PATH_PREFIX = "/transcripts/";

/** A cached transcript file: `<64-lowercase-hex-sha256>.jsonl`. */
const CACHE_FILE_RE = /^[a-f0-9]{64}\.jsonl$/;
const RAW_SHA256_RE = /^[a-f0-9]{64}$/;
/** An in-flight/orphaned download temp file: `.tmp-<uuid>.jsonl`. */
const TEMP_FILE_RE = /^\.tmp-[0-9a-f-]+\.jsonl$/;

/** Default cache bounds — small enough to stay unobtrusive on disk. */
export const DEFAULT_TRANSCRIPT_CACHE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const DEFAULT_TRANSCRIPT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Grace period before a stray `.tmp-*.jsonl` is swept. Comfortably longer than
 * any real streamed download (the module's 275 MB outlier finishes in seconds),
 * so an orphan is only ever a leftover from a crash/kill mid-download.
 */
export const DEFAULT_TRANSCRIPT_CACHE_TEMP_GRACE_MS = 60 * 60 * 1000;

export function resolveTranscriptCacheDir(userDataDir: string): string {
  return path.join(userDataDir, CACHE_DIR_NAME);
}

/**
 * Remove the entire transcript cache directory. Best-effort (a missing dir or a
 * racing read is a no-op). Called when the signed-in identity changes — sign-out,
 * refresh failure, or account/org switch — so one account's cloud transcript
 * bytes never persist at rest on a shared machine for the next user (FEA-3324).
 * The bytes are otherwise unreachable cross-account (the renderer can only build
 * an `app://` URL from an org-scoped, token-authenticated descriptor, and the
 * cache name is a 256-bit content address it cannot guess); this closes only the
 * data-at-rest window.
 */
export async function purgeTranscriptCache(cacheDir: string): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
}

export function isValidRawSha256(value: string): boolean {
  return RAW_SHA256_RE.test(value);
}

function transcriptCacheFileName(rawSha256: string): string {
  return `${rawSha256}.jsonl`;
}

/** The opaque same-origin URL the renderer fetches for a prepared transcript. */
export function buildTranscriptAppUrl(rawSha256: string): string {
  return `app://renderer${TRANSCRIPT_APP_PATH_PREFIX}${transcriptCacheFileName(
    rawSha256
  )}`;
}

/**
 * Extract + validate the cache filename from an `app://` transcripts pathname.
 * Returns null for a non-transcripts path or any name that is not exactly a
 * `<sha256>.jsonl` — so path traversal (`..`, separators, other extensions)
 * can never reach the cache directory.
 */
export function transcriptCacheFileFromPathname(
  pathname: string
): string | null {
  if (!pathname.startsWith(TRANSCRIPT_APP_PATH_PREFIX)) {
    return null;
  }
  const name = pathname.slice(TRANSCRIPT_APP_PATH_PREFIX.length);
  return CACHE_FILE_RE.test(name) ? name : null;
}

/** Minimal fetch shape this module needs (a test seam over the platform fetch). */
export type TranscriptFetch = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: "error" }
) => Promise<Response>;

export type EnsureTranscriptCachedInput = {
  cacheDir: string;
  /** Authoritative archive identity from the read route (never renderer-supplied). */
  rawSha256: string;
  /** Short-lived signed S3 GET URL, minted by main via the read route. */
  signedUrl: string;
  fetchImpl: TranscriptFetch;
  signal?: AbortSignal;
  /**
   * Wall-clock ms stamped onto an existing entry's mtime on a cache hit, so the
   * sweep's age + size (LRU-by-mtime) accounting reflects last access. Defaults
   * to `Date.now()`; a test seam mirroring `evictTranscriptCache`'s `now`.
   */
  now?: number;
};

/**
 * Stamp an existing cache entry's mtime with `nowMs` (wall-clock ms) so the
 * sweep — which evicts by mtime for BOTH the age bound and the size-cap LRU —
 * treats a re-open as last ACCESS rather than original download/stage time.
 * Best-effort: a raced deletion between the caller's existence check and this
 * `utimes` must never fail the serve (the caller only needs the path back), so
 * any error is swallowed. `utimes` takes seconds, hence the `/ 1000`.
 */
async function touchCacheEntry(filePath: string, nowMs: number): Promise<void> {
  const accessedAtSeconds = nowMs / 1000;
  await utimes(filePath, accessedAtSeconds, accessedAtSeconds).catch(
    () => undefined
  );
}

/**
 * Ensure the transcript for `rawSha256` is present in the cache, streaming it
 * from `signedUrl` when absent, and return the absolute cache file path. The
 * download lands in a unique temp file first and is atomically renamed into
 * place, so a partial/failed download never leaves a truncated file that the
 * protocol handler could serve.
 */
export async function ensureTranscriptCached(
  input: EnsureTranscriptCachedInput
): Promise<string> {
  if (!isValidRawSha256(input.rawSha256)) {
    throw new Error("Transcript archive identity is malformed.");
  }
  const filePath = path.join(
    input.cacheDir,
    transcriptCacheFileName(input.rawSha256)
  );
  if (existsSync(filePath)) {
    // Cache hit — refresh the entry's mtime so the sweep's age + size
    // (LRU-by-mtime) eviction reflect last ACCESS, not download time (else a
    // hot, repeatedly re-opened transcript still ages out and forces a full S3
    // re-download of up to ~275 MB).
    await touchCacheEntry(filePath, input.now ?? Date.now());
    return filePath;
  }

  // SSRF policy — the signed URL is minted by the read route, but a compromised
  // read-route response (or attacker-controlled S3 redirect metadata) could point
  // it at an internal host. Validate the host on the same closed policy every
  // other main-process signed-S3 fetch uses (a transcript GET is shaped exactly
  // like a loop-attachment download), and refuse to follow redirects so a 3xx to
  // 169.254.169.254 or a private address can never be fetched and cached.
  const policyDecision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    input.signedUrl
  );
  if (!policyDecision.allowed) {
    throw new Error(
      `Transcript download URL denied (${policyDecision.diagnostics.reason}).`
    );
  }

  await mkdir(input.cacheDir, { recursive: true });
  const response = await input.fetchImpl(input.signedUrl, {
    redirect: "error",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!(response.ok && response.body)) {
    throw new Error(`Failed to fetch transcript (HTTP ${response.status}).`);
  }

  const tempPath = path.join(input.cacheDir, `.tmp-${randomUUID()}.jsonl`);
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
      createWriteStream(tempPath)
    );
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await rename(tempPath, filePath);
  return filePath;
}

/**
 * Byte size of a pre-vetted local transcript, or null when it can't be stat'd
 * (raced deletion, permission). Used by the read bridge to apply the renderer's
 * auto-load cap to a LOCAL fallback file BEFORE staging its bytes — a `statSync`
 * is O(1) versus the streamed copy `stageLocalTranscript` performs, so a 275 MB
 * outlier is gated without ever being read. `sourcePath` MUST already be the
 * canonical real path returned by `resolveTrustedClaudeTranscriptPath` (never
 * renderer-supplied).
 */
export function statLocalTranscriptSize(sourcePath: string): number | null {
  try {
    const stats = statSync(sourcePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

export type StageLocalTranscriptInput = {
  cacheDir: string;
  /**
   * A pre-vetted, canonical real path to a local transcript `.jsonl` — the
   * caller MUST have re-anchored it through the trusted-path resolver
   * (`resolveTrustedClaudeTranscriptPath`) so it cannot be renderer-supplied and
   * cannot escape the known transcript root. This function never derives the path
   * from renderer input.
   */
  sourcePath: string;
  signal?: AbortSignal;
  /**
   * Wall-clock ms stamped onto the entry's mtime when this stage is a cache hit
   * (the bytes are already cached), so its LRU/age accounting reflects last
   * access. Defaults to `Date.now()`; the same test seam as `evictTranscriptCache`.
   */
  now?: number;
};

/**
 * Stage a LOCAL transcript file into the same content-addressed transcript cache
 * the cloud path uses, and return the opaque `app://renderer/transcripts/…` URL
 * for it. Used as the graceful fallback when the cloud (S3) read fails or the
 * file is not cloud-readable yet, so the renderer contract is identical to the
 * cloud path (same-origin `app://` URL, streamed, no renderer-supplied URL).
 *
 * The file's sha256 is computed in a single streamed pass (multi-GB safe, never
 * buffered whole) and becomes the cache identity — exactly the archive-identity
 * convention the cloud path relies on — so a later cloud read of the same bytes
 * hits the same cache entry, and eviction/age accounting treat it identically.
 * The staged bytes land in a unique temp file and are atomically renamed into
 * place, so a partial copy never leaves a truncated file the protocol handler
 * could serve.
 */
export async function stageLocalTranscript(
  input: StageLocalTranscriptInput
): Promise<{ url: string; rawSha256: string }> {
  await mkdir(input.cacheDir, { recursive: true });
  const tempPath = path.join(input.cacheDir, `.tmp-${randomUUID()}.jsonl`);
  const hash = createHash("sha256");
  try {
    const source = createReadStream(input.sourcePath, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    source.on("data", (chunk) => hash.update(chunk));
    await pipeline(source, createWriteStream(tempPath));
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const rawSha256 = hash.digest("hex");
  const filePath = path.join(
    input.cacheDir,
    transcriptCacheFileName(rawSha256)
  );
  if (existsSync(filePath)) {
    // Already cached under this content address (e.g. a prior cloud read of the
    // same bytes) — drop the redundant staged copy and reuse the existing entry.
    // This re-open is an access, so refresh its mtime too — keeping the "eviction
    // /age accounting treat it identically" promise above true against the
    // cloud path's cache-hit bump (FEA-3486).
    await rm(tempPath, { force: true }).catch(() => undefined);
    await touchCacheEntry(filePath, input.now ?? Date.now());
  } else {
    await rename(tempPath, filePath);
  }
  return { url: buildTranscriptAppUrl(rawSha256), rawSha256 };
}

export type EvictTranscriptCacheInput = {
  cacheDir: string;
  maxTotalBytes: number;
  maxAgeMs: number;
  now: number;
  /** Grace before a stray `.tmp-*.jsonl` orphan is swept; defaults to 1h. */
  tempGraceMs?: number;
  /**
   * A cache entry (by lowercase-hex `rawSha256`) the sweep must NEVER evict —
   * the file `prepareTranscript` just downloaded/staged and is about to hand the
   * renderer an `app://` URL for. Without this the same-transaction sweep that
   * runs right after the download could evict that very file — for a single
   * transcript larger than `maxTotalBytes` the size-cap pass would delete it
   * unconditionally — so the returned URL would 404 on the very first fetch
   * (FEA-3624). Protecting it keeps prepare's own bounds enforcement from racing
   * the URL it just minted, while every OTHER entry still ages/LRU-evicts.
   */
  protectedSha256?: string;
};

type CacheEntry = { file: string; size: number; mtimeMs: number };

/** Stat every `<sha256>.jsonl` in `names`, skipping any that raced a delete. */
async function collectCacheEntries(
  cacheDir: string,
  names: string[]
): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];
  for (const name of names) {
    if (!CACHE_FILE_RE.test(name)) {
      continue;
    }
    try {
      const file = path.join(cacheDir, name);
      const stats = await stat(file);
      entries.push({ file, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch {
      // Raced with another sweep/delete — skip.
    }
  }
  return entries;
}

/**
 * Delete stray `.tmp-*.jsonl` orphans older than `graceMs`. A download killed
 * mid-stream never gets its rename, and these never match `<sha256>.jsonl` (so
 * the size/age accounting ignores them) — without this they would leak forever.
 * Best-effort; a racing delete is skipped.
 */
async function sweepStaleTempFiles(
  cacheDir: string,
  names: string[],
  now: number,
  graceMs: number
): Promise<void> {
  const stale: string[] = [];
  for (const name of names) {
    if (!TEMP_FILE_RE.test(name)) {
      continue;
    }
    try {
      const file = path.join(cacheDir, name);
      const stats = await stat(file);
      if (now - stats.mtimeMs > graceMs) {
        stale.push(file);
      }
    } catch {
      // Raced with another sweep/delete — skip.
    }
  }
  await Promise.all(
    stale.map((file) => rm(file, { force: true }).catch(() => undefined))
  );
}

/**
 * Best-effort cache sweep. First delete stray `.tmp-*.jsonl` orphans older than
 * `tempGraceMs` (crash leftovers), then delete `<sha256>.jsonl` entries older
 * than `maxAgeMs`, and finally, if the cache still exceeds `maxTotalBytes`,
 * delete oldest-first (LRU by mtime) until it fits. Never throws; a missing
 * cache dir or a racing delete is a no-op.
 */
export async function evictTranscriptCache(
  input: EvictTranscriptCacheInput
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(input.cacheDir);
  } catch {
    return;
  }

  await sweepStaleTempFiles(
    input.cacheDir,
    names,
    input.now,
    input.tempGraceMs ?? DEFAULT_TRANSCRIPT_CACHE_TEMP_GRACE_MS
  );
  const allEntries = await collectCacheEntries(input.cacheDir, names);
  // Hold back the just-prepared entry so prepare's own sweep can never evict the
  // file it is about to hand back an `app://` URL for (FEA-3624). It still counts
  // toward the size total (so OTHER entries evict to make room for it), it just is
  // never itself a deletion candidate this pass.
  const protectedFile = input.protectedSha256
    ? path.join(input.cacheDir, transcriptCacheFileName(input.protectedSha256))
    : null;
  const entries = protectedFile
    ? allEntries.filter((entry) => entry.file !== protectedFile)
    : allEntries;
  const protectedSize = protectedFile
    ? (allEntries.find((entry) => entry.file === protectedFile)?.size ?? 0)
    : 0;

  // Age-based eviction first.
  let live = entries;
  const expired = entries.filter(
    (entry) => input.now - entry.mtimeMs > input.maxAgeMs
  );
  if (expired.length > 0) {
    await Promise.all(
      expired.map((entry) =>
        rm(entry.file, { force: true }).catch(() => undefined)
      )
    );
    const expiredFiles = new Set(expired.map((entry) => entry.file));
    live = entries.filter((entry) => !expiredFiles.has(entry.file));
  }

  // Size-based LRU eviction (oldest mtime first) until under the cap. The
  // protected (just-prepared) entry is excluded from `live` so it is never a
  // deletion candidate, but its bytes are still counted toward the total so the
  // OTHER entries evict to make room for it.
  let total = live.reduce((sum, entry) => sum + entry.size, 0) + protectedSize;
  if (total <= input.maxTotalBytes) {
    return;
  }
  const byOldest = [...live].sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of byOldest) {
    if (total <= input.maxTotalBytes) {
      break;
    }
    await rm(entry.file, { force: true }).catch(() => undefined);
    total -= entry.size;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

/**
 * Resolve an `app://renderer/transcripts/…` pathname to a real file in
 * `cacheDir`, or null if the name is not an exact `<sha256>.jsonl`, the file is
 * absent, or (defense in depth) the realpath escapes the cache root. The caller
 * (the `app://` protocol handler) streams the returned file; nothing is buffered
 * here. `size` is returned so the handler can set `Content-Length`.
 */
export function resolveCachedTranscriptFile(
  cacheDir: string,
  pathname: string
): { filePath: string; size: number } | null {
  const fileName = transcriptCacheFileFromPathname(pathname);
  if (!fileName) {
    return null;
  }
  const filePath = path.join(cacheDir, fileName);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const realRoot = realpathSync(cacheDir);
    const realFile = realpathSync(filePath);
    const stats = statSync(realFile);
    if (!(stats.isFile() && isPathInside(realFile, realRoot))) {
      return null;
    }
    return { filePath: realFile, size: stats.size };
  } catch {
    return null;
  }
}
