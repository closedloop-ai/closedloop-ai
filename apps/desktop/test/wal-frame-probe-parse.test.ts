/**
 * @file wal-frame-probe-parse.test.ts
 * @description ISS-4723 / ISS-4819: coverage for the production WAL-depth read.
 * The cadence tests inject `probeWalFrames`, so the real read is otherwise never
 * exercised. ISS-4819 moved that read off `PRAGMA wal_checkpoint(PASSIVE)` (which
 * PERFORMS a checkpoint) and onto the `-wal` sidecar's file size, so the pieces
 * under test here are: resolving the sidecar path from the libSQL config URL,
 * converting the sidecar's byte size to a frame count, reading the one-time
 * `PRAGMA page_size` row, and distinguishing "file absent" (a genuinely empty WAL)
 * from every other stat failure (a genuinely UNKNOWN depth). The 0-vs-null
 * distinction is load-bearing: a `null` read must take the unknown fallback, never
 * be read as an empty WAL, which would silently disable the ceiling backstop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SQLITE_DEFAULT_PAGE_SIZE_BYTES,
  WAL_FILE_HEADER_BYTES,
  WAL_FRAME_HEADER_BYTES,
} from "../src/main/database/connection-pragmas.js";
import {
  isMissingFileError,
  readPragmaNumber,
  walFramesFromFileBytes,
  walSidecarPath,
} from "../src/main/database/prisma-client.js";

const FRAME_BYTES = WAL_FRAME_HEADER_BYTES + SQLITE_DEFAULT_PAGE_SIZE_BYTES;

test("walSidecarPath appends the -wal suffix to a file: config URL", () => {
  assert.equal(
    walSidecarPath("file:/store/agent-dashboard.sqlite"),
    "/store/agent-dashboard.sqlite-wal"
  );
});

test("walSidecarPath strips a libSQL query string before suffixing", () => {
  assert.equal(
    walSidecarPath("file:/store/agent-dashboard.sqlite?mode=rwc"),
    "/store/agent-dashboard.sqlite-wal"
  );
});

test("walSidecarPath returns null when there is no local file to measure", () => {
  // No sidecar exists for an in-memory or remote store, so the depth is
  // unknowable from the filesystem and the caller must take the unknown fallback
  // (fire the base timer TRUNCATE) rather than assume an empty WAL.
  assert.equal(walSidecarPath("file::memory:"), null);
  assert.equal(walSidecarPath("file:"), null);
  assert.equal(walSidecarPath("libsql://example.turso.io"), null);
  assert.equal(walSidecarPath("https://example.turso.io"), null);
});

test("walFramesFromFileBytes converts a sidecar size to a frame count", () => {
  // A WAL file is a 32-byte header followed by N (24-byte header + page) frames.
  assert.equal(
    walFramesFromFileBytes(
      WAL_FILE_HEADER_BYTES + FRAME_BYTES * 3,
      SQLITE_DEFAULT_PAGE_SIZE_BYTES
    ),
    3
  );
});

test("walFramesFromFileBytes honours a non-default page size", () => {
  // The page size is read from the store rather than assumed, so a store on 8 KiB
  // pages must not be reported as having twice as many frames as it really has.
  const pageSize = 8192;
  const frameBytes = WAL_FRAME_HEADER_BYTES + pageSize;
  assert.equal(
    walFramesFromFileBytes(WAL_FILE_HEADER_BYTES + frameBytes * 5, pageSize),
    5
  );
});

test("walFramesFromFileBytes reports a genuine 0 for an empty WAL", () => {
  // Header-only (or an entirely empty file) is a real, reclaimed WAL — 0 frames,
  // NOT unknown. The hold path depends on this being distinguishable.
  assert.equal(
    walFramesFromFileBytes(
      WAL_FILE_HEADER_BYTES,
      SQLITE_DEFAULT_PAGE_SIZE_BYTES
    ),
    0
  );
  assert.equal(walFramesFromFileBytes(0, SQLITE_DEFAULT_PAGE_SIZE_BYTES), 0);
});

test("walFramesFromFileBytes floors a partially-written trailing frame", () => {
  // A frame mid-append must not round up into a frame that is not fully there.
  assert.equal(
    walFramesFromFileBytes(
      WAL_FILE_HEADER_BYTES + FRAME_BYTES * 2 + 17,
      SQLITE_DEFAULT_PAGE_SIZE_BYTES
    ),
    2
  );
});

test("walFramesFromFileBytes returns null (not 0) for a nonsensical input", () => {
  assert.equal(
    walFramesFromFileBytes(Number.NaN, SQLITE_DEFAULT_PAGE_SIZE_BYTES),
    null
  );
  assert.equal(
    walFramesFromFileBytes(-1, SQLITE_DEFAULT_PAGE_SIZE_BYTES),
    null
  );
  assert.equal(walFramesFromFileBytes(1024, 0), null);
  assert.equal(walFramesFromFileBytes(1024, -4096), null);
  assert.equal(walFramesFromFileBytes(1024, Number.NaN), null);
});

test("readPragmaNumber reads the value from an array row", () => {
  // The raw adapter surfaces a single-column PRAGMA row positionally...
  assert.equal(readPragmaNumber([[4096]], "page_size"), 4096);
});

test("readPragmaNumber reads the value from an object row", () => {
  // ...or keyed by column name; both shapes must resolve.
  assert.equal(readPragmaNumber([{ page_size: 8192 }], "page_size"), 8192);
});

test("readPragmaNumber returns null for a missing, renamed, or bad row", () => {
  // null — not 0 — so the caller falls back to the documented default page size
  // instead of dividing by a bogus value.
  assert.equal(readPragmaNumber([], "page_size"), null);
  assert.equal(readPragmaNumber([null], "page_size"), null);
  assert.equal(readPragmaNumber([undefined], "page_size"), null);
  assert.equal(readPragmaNumber([{ pageSize: 4096 }], "page_size"), null);
  assert.equal(readPragmaNumber([["not-a-number"]], "page_size"), null);
  assert.equal(readPragmaNumber([[-1]], "page_size"), null);
});

test("isMissingFileError separates an absent sidecar from a real stat failure", () => {
  // An absent -wal means the WAL was fully reclaimed (depth 0). Any OTHER stat
  // failure — permissions, I/O — leaves the depth UNKNOWN, and the cadence must
  // take the base-timer fallback rather than read it as an empty WAL.
  assert.equal(
    isMissingFileError(Object.assign(new Error("x"), { code: "ENOENT" })),
    true
  );
  assert.equal(
    isMissingFileError(Object.assign(new Error("x"), { code: "EACCES" })),
    false
  );
  assert.equal(
    isMissingFileError(Object.assign(new Error("x"), { code: "EIO" })),
    false
  );
  assert.equal(isMissingFileError(new Error("no code")), false);
  assert.equal(isMissingFileError(null), false);
  assert.equal(isMissingFileError("ENOENT"), false);
});
