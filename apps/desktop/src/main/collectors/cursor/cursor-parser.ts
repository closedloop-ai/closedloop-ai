/**
 * @file cursor-parser.ts
 * @description Desktop file-I/O shell around the shared, browser-safe Cursor
 * transcript parser core in `@repo/lib/harness` (FEA-3710; the core was extracted
 * from this module, logic preserved). This module streams a Cursor background-agent
 * transcript JSONL file into the shared `parseCursorTranscript`, then adds the two
 * pieces that require local disk and are DB-import-specific: deriving the session
 * id from the transcript path and stamping the source-file mtime. The extracted
 * core is shared so a future cloud renderer can run the exact same Cursor parsing;
 * the cloud renderer does not yet route Cursor through it (`isCloudParseableHarness`
 * currently covers only Claude and Codex).
 */
import fs from "node:fs";
import readline from "node:readline";
import { parseCursorTranscript } from "@repo/lib/harness/cursor/parse-cursor";
import type { NormalizedSession } from "../types.js";
import { sessionIdFromTranscriptPath } from "./cursor-home.js";

/**
 * Parse a single Cursor agent transcript JSONL file into a NormalizedSession.
 * Returns null when the file carries no usable timestamp (matching the vendor
 * contract). Malformed lines are skipped inside the core; mtime stamping is
 * best-effort.
 */
export async function parseTranscriptFile(
  filePath: string
): Promise<NormalizedSession | null> {
  const sessionId = sessionIdFromTranscriptPath(filePath);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const session = await parseCursorTranscript(rl, { sessionId });
  if (!session) {
    return null;
  }

  try {
    session.fileModifiedAt = fs.statSync(filePath).mtimeMs;
  } catch {
    /* non-fatal */
  }

  return session;
}
