/**
 * @file transcript-read-cache.test.ts
 * @description Unit tests for the main-process cloud-transcript read cache
 * (FEA-3324 Option B2): content-addressed streamed download, path/traversal
 * validation for the `app://` protocol handler, and TTL/size eviction.
 * Exercised against a real temp directory — no Electron. (Distinct from
 * `transcript-cache.test.ts`, which covers the local token-usage memo.)
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  buildTranscriptAppUrl,
  ensureTranscriptCached,
  evictTranscriptCache,
  isValidRawSha256,
  purgeTranscriptCache,
  resolveCachedTranscriptFile,
  resolveTranscriptCacheDir,
  stageLocalTranscript,
  TRANSCRIPT_APP_PATH_PREFIX,
} from "../src/main/transcript/transcript-read-cache.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const S3_URL = "https://bucket.s3.us-east-1.amazonaws.com/obj?sig=1";
const HTTP_403_ERROR = /HTTP 403/;
const MALFORMED_SHA_ERROR = /malformed/i;
const DENIED_URL_ERROR = /denied/i;
/** UUID-shaped temp names (must match `.tmp-[0-9a-f-]+.jsonl`). */
const STALE_TEMP_NAME = ".tmp-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
const FRESH_TEMP_NAME = ".tmp-11111111-2222-3333-4444-555555555555.jsonl";

/** The `app://` pathname the protocol handler receives for a cached sha. */
function transcriptPath(sha: string): string {
  return `${TRANSCRIPT_APP_PATH_PREFIX}${sha}.jsonl`;
}

const testRoot = mkdtempSync(
  path.join(tmpdir(), "transcript-read-cache-test-")
);
let counter = 0;
function freshCacheDir(): string {
  counter += 1;
  return path.join(testRoot, `case-${counter}`);
}

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

/** A streamed fetch stub that returns `body` for any URL, counting calls. */
function streamingFetch(body: string, status = 200) {
  let calls = 0;
  const fetchImpl = (() => {
    calls += 1;
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test("isValidRawSha256 accepts 64 lowercase hex only", () => {
  assert.equal(isValidRawSha256(SHA_A), true);
  assert.equal(isValidRawSha256("A".repeat(64)), false); // uppercase
  assert.equal(isValidRawSha256("a".repeat(63)), false); // too short
  assert.equal(isValidRawSha256(`${"a".repeat(63)}g`), false); // non-hex
});

test("buildTranscriptAppUrl builds a same-origin app:// URL under the prefix", () => {
  assert.equal(
    buildTranscriptAppUrl(SHA_A),
    `app://renderer${transcriptPath(SHA_A)}`
  );
});

test("resolveTranscriptCacheDir nests under userData", () => {
  assert.equal(
    resolveTranscriptCacheDir("/home/u/.config/App"),
    path.join("/home/u/.config/App", "transcript-cache")
  );
});

test("ensureTranscriptCached streams the body to disk and returns the path", async () => {
  const cacheDir = freshCacheDir();
  const { fetchImpl, calls } = streamingFetch("line1\nline2\n");
  const filePath = await ensureTranscriptCached({
    cacheDir,
    rawSha256: SHA_A,
    signedUrl: S3_URL,
    fetchImpl,
  });
  assert.equal(filePath, path.join(cacheDir, `${SHA_A}.jsonl`));
  assert.equal(readFileSync(filePath, "utf8"), "line1\nline2\n");
  assert.equal(calls(), 1);
});

test("ensureTranscriptCached is a cache hit on the second call (no refetch)", async () => {
  const cacheDir = freshCacheDir();
  const { fetchImpl, calls } = streamingFetch("data\n");
  const args = { cacheDir, rawSha256: SHA_A, signedUrl: S3_URL, fetchImpl };
  await ensureTranscriptCached(args);
  await ensureTranscriptCached(args);
  assert.equal(calls(), 1);
});

test("ensureTranscriptCached bumps mtime on a cache hit so the sweep sees last access", async () => {
  const cacheDir = freshCacheDir();
  const { fetchImpl } = streamingFetch("data\n");
  const filePath = await ensureTranscriptCached({
    cacheDir,
    rawSha256: SHA_A,
    signedUrl: S3_URL,
    fetchImpl,
  });
  // Age the just-downloaded entry well past any TTL, simulating a stale entry.
  const staleSeconds = 1000;
  utimesSync(filePath, staleSeconds, staleSeconds);

  // A re-open is a cache hit; it must refresh the entry's mtime to `now`.
  const now = 1_000_000_000_000;
  await ensureTranscriptCached({
    cacheDir,
    rawSha256: SHA_A,
    signedUrl: S3_URL,
    fetchImpl,
    now,
  });
  assert.ok(Math.abs(statSync(filePath).mtimeMs - now) < 1000);

  // Because the hit refreshed the mtime, an age-based sweep at `now` keeps the
  // hot entry instead of evicting it (the FIFO-by-download-time bug: FEA-3486).
  await evictTranscriptCache({
    cacheDir,
    maxTotalBytes: Number.POSITIVE_INFINITY,
    maxAgeMs: 60 * 60 * 1000, // 1h
    now,
  });
  assert.ok(resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A)));
});

test("stageLocalTranscript bumps mtime when the content is already cached", async () => {
  const cacheDir = freshCacheDir();
  const sourcePath = path.join(testRoot, "stage-source.jsonl");
  writeFileSync(sourcePath, "local\nbytes\n");

  // First stage writes the content-addressed entry.
  const { rawSha256 } = await stageLocalTranscript({ cacheDir, sourcePath });
  const filePath = path.join(cacheDir, `${rawSha256}.jsonl`);
  // Age it past any TTL to prove the re-stage refreshes it.
  utimesSync(filePath, 1000, 1000);

  // Re-staging the same bytes is a cache hit — it must refresh the mtime.
  const now = 1_000_000_000_000;
  await stageLocalTranscript({ cacheDir, sourcePath, now });
  assert.ok(Math.abs(statSync(filePath).mtimeMs - now) < 1000);
});

test("ensureTranscriptCached throws on a non-2xx and leaves no cache file", async () => {
  const cacheDir = freshCacheDir();
  const { fetchImpl } = streamingFetch("nope", 403);
  await assert.rejects(
    ensureTranscriptCached({
      cacheDir,
      rawSha256: SHA_A,
      signedUrl: S3_URL,
      fetchImpl,
    }),
    HTTP_403_ERROR
  );
  assert.equal(
    resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A)),
    null
  );
});

test("ensureTranscriptCached denies a non-S3 outbound host (SSRF policy, no fetch)", async () => {
  const cacheDir = freshCacheDir();
  const { fetchImpl, calls } = streamingFetch("data");
  await assert.rejects(
    ensureTranscriptCached({
      cacheDir,
      rawSha256: SHA_A,
      signedUrl: "https://evil.example.com/obj?sig=1",
      fetchImpl,
    }),
    DENIED_URL_ERROR
  );
  // Blocked before any network I/O and before the cache dir is created.
  assert.equal(calls(), 0);
  assert.equal(existsSync(cacheDir), false);
});

test("ensureTranscriptCached rejects a malformed archive identity (no fetch)", async () => {
  const cacheDir = freshCacheDir();
  const { fetchImpl, calls } = streamingFetch("data");
  await assert.rejects(
    ensureTranscriptCached({
      cacheDir,
      rawSha256: "../etc/passwd",
      signedUrl: S3_URL,
      fetchImpl,
    }),
    MALFORMED_SHA_ERROR
  );
  assert.equal(calls(), 0);
});

test("resolveCachedTranscriptFile serves a valid cached file and rejects traversal", async () => {
  const cacheDir = freshCacheDir();
  await ensureTranscriptCached({
    cacheDir,
    rawSha256: SHA_A,
    signedUrl: S3_URL,
    fetchImpl: streamingFetch("body-bytes\n").fetchImpl,
  });

  const ok = resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A));
  assert.ok(ok);
  assert.equal(ok.size, "body-bytes\n".length);

  // Not a transcripts path.
  assert.equal(resolveCachedTranscriptFile(cacheDir, "/assets/x.js"), null);
  // Wrong extension.
  assert.equal(
    resolveCachedTranscriptFile(
      cacheDir,
      `${TRANSCRIPT_APP_PATH_PREFIX}${SHA_A}.js`
    ),
    null
  );
  // Traversal / separators in the name — never matches `<sha>.jsonl`.
  assert.equal(
    resolveCachedTranscriptFile(
      cacheDir,
      `${TRANSCRIPT_APP_PATH_PREFIX}../secret.jsonl`
    ),
    null
  );
  assert.equal(
    resolveCachedTranscriptFile(
      cacheDir,
      `${TRANSCRIPT_APP_PATH_PREFIX}sub/${SHA_A}.jsonl`
    ),
    null
  );
  // Absent file.
  assert.equal(
    resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_B)),
    null
  );
});

test("evictTranscriptCache deletes entries older than maxAgeMs", async () => {
  const cacheDir = freshCacheDir();
  const now = 1_000_000_000_000;
  mkdirSync(cacheDir, { recursive: true });
  const fresh = path.join(cacheDir, `${SHA_A}.jsonl`);
  const old = path.join(cacheDir, `${SHA_B}.jsonl`);
  writeFileSync(fresh, "x");
  writeFileSync(old, "y");
  const oldSeconds = (now - 10 * 60 * 60 * 1000) / 1000;
  utimesSync(old, oldSeconds, oldSeconds);

  await evictTranscriptCache({
    cacheDir,
    maxTotalBytes: Number.POSITIVE_INFINITY,
    maxAgeMs: 60 * 60 * 1000, // 1h
    now,
  });

  assert.ok(resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A)));
  assert.equal(
    resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_B)),
    null
  );
});

test("evictTranscriptCache trims oldest-first until under the size cap", async () => {
  const cacheDir = freshCacheDir();
  const now = 1_000_000_000_000;
  mkdirSync(cacheDir, { recursive: true });
  const shas = [SHA_A, SHA_B, SHA_C];
  shas.forEach((sha, index) => {
    const file = path.join(cacheDir, `${sha}.jsonl`);
    writeFileSync(file, "0".repeat(100));
    // A oldest, C newest.
    const seconds = (now - (3 - index) * 1000) / 1000;
    utimesSync(file, seconds, seconds);
  });

  await evictTranscriptCache({
    cacheDir,
    maxTotalBytes: 250, // 3×100 over cap → drop the oldest (A) → 200
    maxAgeMs: Number.POSITIVE_INFINITY,
    now,
  });

  assert.equal(
    resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A)),
    null
  );
  assert.ok(resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_B)));
  assert.ok(resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_C)));
});

test("evictTranscriptCache never evicts the protected (just-prepared) entry, even over the size cap (FEA-3624)", async () => {
  const cacheDir = freshCacheDir();
  const now = 1_000_000_000_000;
  mkdirSync(cacheDir, { recursive: true });
  // The just-prepared entry (A) is the NEWEST, but is also larger than the whole
  // cap on its own — without protection the size-cap pass would delete it and the
  // `app://` URL prepare is about to return would 404 on its first fetch.
  const prepared = path.join(cacheDir, `${SHA_A}.jsonl`);
  const older = path.join(cacheDir, `${SHA_B}.jsonl`);
  writeFileSync(prepared, "0".repeat(300));
  writeFileSync(older, "0".repeat(100));
  const preparedSeconds = now / 1000;
  const olderSeconds = (now - 5000) / 1000;
  utimesSync(prepared, preparedSeconds, preparedSeconds);
  utimesSync(older, olderSeconds, olderSeconds);

  await evictTranscriptCache({
    cacheDir,
    maxTotalBytes: 250, // both together (400) exceed the cap
    maxAgeMs: Number.POSITIVE_INFINITY,
    now,
    protectedSha256: SHA_A,
  });

  // The protected entry survives; the OTHER entry evicts to make room for it.
  assert.ok(resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A)));
  assert.equal(
    resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_B)),
    null
  );
});

test("evictTranscriptCache never age-evicts the protected entry (FEA-3624)", async () => {
  const cacheDir = freshCacheDir();
  const now = 1_000_000_000_000;
  mkdirSync(cacheDir, { recursive: true });
  const protectedFile = path.join(cacheDir, `${SHA_A}.jsonl`);
  writeFileSync(protectedFile, "x");
  // Age it well past maxAgeMs — a normal pass would delete it, but protection
  // holds it (defensive: the just-prepared file has a fresh mtime in practice).
  const oldSeconds = (now - 100 * 60 * 60 * 1000) / 1000;
  utimesSync(protectedFile, oldSeconds, oldSeconds);

  await evictTranscriptCache({
    cacheDir,
    maxTotalBytes: Number.POSITIVE_INFINITY,
    maxAgeMs: 60 * 60 * 1000,
    now,
    protectedSha256: SHA_A,
  });

  assert.ok(resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A)));
});

test("evictTranscriptCache sweeps stale .tmp orphans but keeps fresh ones", async () => {
  const cacheDir = freshCacheDir();
  const now = 1_000_000_000_000;
  mkdirSync(cacheDir, { recursive: true });
  const staleTemp = path.join(cacheDir, STALE_TEMP_NAME);
  const freshTemp = path.join(cacheDir, FRESH_TEMP_NAME);
  writeFileSync(staleTemp, "partial-download");
  writeFileSync(freshTemp, "partial-download");
  const staleSeconds = (now - 2 * 60 * 60 * 1000) / 1000; // 2h old
  utimesSync(staleTemp, staleSeconds, staleSeconds);

  await evictTranscriptCache({
    cacheDir,
    maxTotalBytes: Number.POSITIVE_INFINITY,
    maxAgeMs: Number.POSITIVE_INFINITY,
    now,
    tempGraceMs: 60 * 60 * 1000, // 1h — a crash orphan older than this is swept.
  });

  // The orphan past the grace is gone; an in-flight temp within grace survives.
  assert.equal(existsSync(staleTemp), false);
  assert.equal(existsSync(freshTemp), true);
});

test("purgeTranscriptCache removes the whole cache dir and is idempotent", async () => {
  const cacheDir = freshCacheDir();
  await ensureTranscriptCached({
    cacheDir,
    rawSha256: SHA_A,
    signedUrl: S3_URL,
    fetchImpl: streamingFetch("body\n").fetchImpl,
  });
  assert.ok(resolveCachedTranscriptFile(cacheDir, transcriptPath(SHA_A)));

  await purgeTranscriptCache(cacheDir);
  assert.equal(existsSync(cacheDir), false);
  // Purging an already-absent dir is a no-op (best-effort).
  await purgeTranscriptCache(cacheDir);
  assert.equal(existsSync(cacheDir), false);
});
