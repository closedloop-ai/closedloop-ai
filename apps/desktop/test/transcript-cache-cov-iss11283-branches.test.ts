/**
 * @file ISS-11283 branch coverage for database/transcript.ts paths the
 * existing suites (transcript-cache.test.ts, file-size-admission.test.ts,
 * attribution-transcript-extractor.test.ts) never exercise: the
 * compaction-summary counter, the API-error timestamp tracking's `||`/`&&`
 * leaf that only evaluates when `message.type === "error"`, the oversized-
 * cache-eviction paths in `createTranscriptCache`, its incremental-growth
 * read (both a complete newly-appended line and a still-partial one with no
 * trailing newline), and the unreadable-file catch when the path was
 * previously cached vs never cached.
 *
 * Every case pins FIXED_MTIME: a natural write's mtime carries a sub-ms part
 * that a `Date` reset drops, so the re-stat would not match the cached mtime
 * and the incremental branch would never run.
 */
import {
  appendFileSync,
  mkdirSync,
  rmdirSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTranscriptCache } from "../src/main/database/transcript.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const { makeTempDir } = createTempDirManager("transcript-cov-");

const MODEL = "claude-3-5-sonnet-20241022";
const FIXED_MTIME = new Date("2025-06-01T00:00:00.000Z");
const OVER_LARGE_FILE_SIZE_BYTES = 200 * 1024 * 1024 + 1;

function usageLine(overrides: {
  uuid: string;
  inputTokens: number;
  timestamp: string;
}) {
  return {
    uuid: overrides.uuid,
    message: {
      model: MODEL,
      usage: {
        input_tokens: overrides.inputTokens,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
      id: `msg_${overrides.uuid}`,
    },
    requestId: `req_${overrides.uuid}`,
    timestamp: overrides.timestamp,
  };
}

describe("processLinesIntoMap: compaction summary counter", () => {
  it("increments compactionCount for an isCompactSummary line", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "session.jsonl");
    writeFileSync(
      fp,
      `${JSON.stringify({ isCompactSummary: true })}\n${JSON.stringify(
        usageLine({
          uuid: "00000000-0000-4000-8000-000000000001",
          inputTokens: 10,
          timestamp: "2025-06-01T00:00:00Z",
        })
      )}\n`,
      "utf8"
    );
    const cache = createTranscriptCache();
    const result = cache(fp);
    expect(result?.compactionCount).toBe(1);
  });
});

describe("processLinesIntoMap: API-error timestamp tracking", () => {
  it("tracks message.type==='error' (no isApiErrorMessage flag) and keeps the LATER of two error timestamps", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "session.jsonl");
    // Line 1: no `isApiErrorMessage`, so the `||`'s left operand is false and
    // `message.type === "error" && message.error != null` must be evaluated
    // (and both operands are true) to record this as an API error at T5.
    const line1 = {
      timestamp: "2025-06-01T00:00:05Z",
      message: { type: "error", error: "server overloaded" },
    };
    // Line 2: a real assistant turn at T8, so `latestAssistantTs` becomes T8.
    const line2 = usageLine({
      uuid: "00000000-0000-4000-8000-000000000002",
      inputTokens: 10,
      timestamp: "2025-06-01T00:00:08Z",
    });
    // Line 3: a second, LATER API error at T10 (`isApiErrorMessage: true`
    // this time). `apiErrorTs` is already truthy (T5) from line 1, so
    // `!apiErrorTs` is false and `ts > apiErrorTs` must be evaluated; it is
    // true (T10 > T5), so `apiErrorTs` correctly advances to T10.
    const line3 = {
      timestamp: "2025-06-01T00:00:10Z",
      isApiErrorMessage: true,
    };
    writeFileSync(
      fp,
      `${JSON.stringify(line1)}\n${JSON.stringify(line2)}\n${JSON.stringify(line3)}\n`,
      "utf8"
    );
    const cache = createTranscriptCache();
    const result = cache(fp);
    // hasTrailingUnrecoveredApiError(apiErrorTs, assistantTs) = apiErrorTs >=
    // assistantTs. If `ts > apiErrorTs` had never been evaluated (or always
    // stayed false), `apiErrorTs` would incorrectly stay at T5, which is
    // BEFORE T8 — flipping this to false. Only the correctly-advanced T10 (>
    // T8) makes it true.
    expect(result?.hasTrailingApiError).toBe(true);
  });
});

describe("createTranscriptCache: oversized-file eviction", () => {
  it("evicts a previously-cached entry once the file grows past the size cap", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "session.jsonl");
    const original = usageLine({
      uuid: "00000000-0000-4000-8000-000000000010",
      inputTokens: 100,
      timestamp: "2025-06-01T00:00:00Z",
    });
    writeFileSync(fp, `${JSON.stringify(original)}\n`, "utf8");
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);
    const cache = createTranscriptCache();
    const cached = cache(fp);
    expect(cached?.tokensByModel.get(original.message.model)?.input).toBe(100);

    // Grow the file past the cap; the size check fires before any mtime/size
    // comparison, so this evicts the cached entry (`if (cached)` true) and
    // returns null WITHOUT reading the oversized content.
    truncateSync(fp, OVER_LARGE_FILE_SIZE_BYTES);
    expect(cache(fp)).toBeNull();

    // Shrink back to the SAME byte length and mtime as the original cached
    // stat, but with a DIFFERENT token value (100 -> 999, an equal-width
    // digit swap so the file size is unchanged). If eviction had not
    // happened, the next call's `cached.mtimeMs === st.mtimeMs &&
    // cached.fileSize === st.size` unchanged-fast-path would match and
    // return the STALE 100-token dedup map without re-reading. Only a real
    // eviction forces the full re-read that picks up 999.
    const replacement = usageLine({
      uuid: "00000000-0000-4000-8000-000000000010",
      inputTokens: 999,
      timestamp: "2025-06-01T00:00:00Z",
    });
    expect(JSON.stringify(replacement).length).toBe(
      JSON.stringify(original).length
    );
    writeFileSync(fp, `${JSON.stringify(replacement)}\n`, "utf8");
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);

    const afterEviction = cache(fp);
    expect(
      afterEviction?.tokensByModel.get(original.message.model)?.input
    ).toBe(999);
  });

  it("skips the (no-op) delete when a file is oversized on its very first read", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "session.jsonl");
    writeFileSync(fp, "", "utf8");
    truncateSync(fp, OVER_LARGE_FILE_SIZE_BYTES);
    const cache = createTranscriptCache();
    // Never cached before, so `cached` is falsy going into the size check —
    // still returns null cleanly.
    expect(cache(fp)).toBeNull();
  });
});

describe("createTranscriptCache: incremental growth read", () => {
  it("reads only the newly-appended, newline-terminated bytes when the file grows at the same mtime", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "session.jsonl");
    writeFileSync(
      fp,
      `${JSON.stringify(
        usageLine({
          uuid: "00000000-0000-4000-8000-000000000020",
          inputTokens: 100,
          timestamp: "2025-06-01T00:00:00Z",
        })
      )}\n`,
      "utf8"
    );
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);
    const cache = createTranscriptCache();
    const first = cache(fp);
    expect(first?.tokensByModel.size).toBe(1);

    const appended = usageLine({
      uuid: "00000000-0000-4000-8000-000000000021",
      inputTokens: 200,
      timestamp: "2025-06-01T00:00:01Z",
    });
    appendFileSync(fp, `${JSON.stringify(appended)}\n`, "utf8");
    // Reset to the SAME fixed mtime (both stats derive from the identical
    // Date value, so they compare exactly equal) — this is the incremental-
    // growth precondition: same mtime, larger size.
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);

    const second = cache(fp);
    // Two distinct dedup entries accumulated across the incremental read: the
    // original 100 plus the newly-appended 200, summed onto the same model.
    expect(second?.tokensByModel.get(appended.message.model)?.input).toBe(300);
  });

  it("leaves the dedup map unchanged when the newly-grown bytes have no trailing newline yet", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "session.jsonl");
    writeFileSync(
      fp,
      `${JSON.stringify(
        usageLine({
          uuid: "00000000-0000-4000-8000-000000000030",
          inputTokens: 100,
          timestamp: "2025-06-01T00:00:00Z",
        })
      )}\n`,
      "utf8"
    );
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);
    const cache = createTranscriptCache();
    const first = cache(fp);
    expect(first?.tokensByModel.size).toBe(1);

    // Append a partial line with NO trailing newline — a write still in
    // flight from the writer's perspective. `readFileRangeSync` finds no
    // newline in the appended range and returns "".
    appendFileSync(
      fp,
      JSON.stringify(
        usageLine({
          uuid: "00000000-0000-4000-8000-000000000031",
          inputTokens: 200,
          timestamp: "2025-06-01T00:00:01Z",
        })
      ),
      "utf8"
    );
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);

    const second = cache(fp);
    // No new dedup entry: the partial line was never parsed.
    expect(second?.tokensByModel.size).toBe(1);
    expect(second?.tokensByModel.get(MODEL)?.input).toBe(100);
  });
});

describe("createTranscriptCache: unreadable-path catch", () => {
  it("evicts a previously-cached entry when the path becomes unreadable (a directory replaces the file)", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "session.jsonl");
    writeFileSync(
      fp,
      `${JSON.stringify(
        usageLine({
          uuid: "00000000-0000-4000-8000-000000000040",
          inputTokens: 100,
          timestamp: "2025-06-01T00:00:00Z",
        })
      )}\n`,
      "utf8"
    );
    // Pin the mtime BEFORE the first read so the cached stat and the restored
    // file below carry the same millisecond-clean mtime. A natural write mtime
    // has a sub-millisecond part that utimesSync cannot reproduce, so without
    // this the unchanged fast path could never match and the test would pass
    // even with the catch's eviction removed.
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);
    const cache = createTranscriptCache();
    expect(cache(fp)?.tokensByModel.size).toBe(1);

    // Replace the cached file with a directory of the same name: statSync
    // still succeeds (different mtime/size, so neither the unchanged nor the
    // incremental fast path matches), but readFileSync throws EISDIR.
    unlinkSync(fp);
    mkdirSync(fp);

    expect(cache(fp)).toBeNull();

    // Restore a file at the exact same mtime/size as the ORIGINAL cached
    // stat (both FIXED_MTIME), but with a different token value (100 -> 999, an equal-width
    // digit swap so the byte length is unchanged). If the catch had not
    // evicted the stale entry, this call's `cached.mtimeMs === st.mtimeMs &&
    // cached.fileSize === st.size` unchanged-fast-path would match and
    // return the STALE 100-token map without re-reading; only a real
    // eviction forces the full re-read that picks up 999.
    const replacement = usageLine({
      uuid: "00000000-0000-4000-8000-000000000040",
      inputTokens: 999,
      timestamp: "2025-06-01T00:00:00Z",
    });
    rmdirSync(fp);
    writeFileSync(fp, `${JSON.stringify(replacement)}\n`, "utf8");
    utimesSync(fp, FIXED_MTIME, FIXED_MTIME);

    const afterEviction = cache(fp);
    expect(afterEviction?.tokensByModel.get(MODEL)?.input).toBe(999);
  });

  it("stays a no-op when a never-cached path is unreadable from the start", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "was-never-cached");
    mkdirSync(fp);
    const cache = createTranscriptCache();
    expect(cache(fp)).toBeNull();
  });
});
