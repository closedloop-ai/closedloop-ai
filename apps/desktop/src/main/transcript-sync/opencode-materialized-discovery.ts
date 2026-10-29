/**
 * @file opencode-materialized-discovery.ts
 * @description FEA-3932: enumerate the OpenCode projection files the materializer
 * (`opencode-materializer.ts`) writes under
 * `<stateDir>/transcript-materialized/opencode/<externalSessionId>/<fileKey>.jsonl`.
 * The layout already encodes the transcript identity: the first path segment is
 * the `externalSessionId` (`opencode-<id>`) and the file stem is the `fileKey`
 * (`main` or `subagent:<id>`), so mapping to `(externalSessionId, fileKey)` is a
 * direct read of the path — no DB access or parent walking here.
 *
 * Best-effort and error-tolerant like the other collectors: an absent root (no
 * OpenCode sessions materialized yet) or an unreadable subdir yields an empty
 * list rather than throwing into the discovery sweep.
 */
import fs from "node:fs";
import path from "node:path";
import {
  type DirectoryWalkSkipOptions,
  reportReaddirSkip,
} from "../collectors/engine/directory-walk-skip.js";
import { opencodeMaterializedRoot } from "./opencode-materializer.js";

const JSONL_EXTENSION = ".jsonl";

/** One discovered materialized OpenCode file mapped to its transcript identity. */
export type OpencodeMaterializedFile = {
  externalSessionId: string;
  fileKey: string;
  sourcePath: string;
};

/**
 * List every `<root>/<externalSessionId>/<fileKey>.jsonl` under the materialized
 * OpenCode root. Non-`.jsonl` entries and unreadable subdirs are skipped.
 *
 * Skipping stays the behaviour; `onSkip` only makes it observable, so a caller
 * measuring the corpus can report a short listing as short (ISS-8506). An
 * absent root never reports — an unmaterialized projection is the ordinary
 * pre-consent state and the harness probe already speaks for it.
 */
export function listOpencodeMaterializedFiles(
  stateDir: string,
  { onSkip }: DirectoryWalkSkipOptions = {}
): OpencodeMaterializedFile[] {
  const root = opencodeMaterializedRoot(stateDir);
  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    reportReaddirSkip(root, error, onSkip);
    return [];
  }
  const files: OpencodeMaterializedFile[] = [];
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) {
      continue;
    }
    const externalSessionId = sessionDir.name;
    const dirPath = path.join(root, externalSessionId);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
      reportReaddirSkip(dirPath, error, onSkip);
      continue;
    }
    for (const entry of entries) {
      if (!(entry.isFile() && entry.name.endsWith(JSONL_EXTENSION))) {
        continue;
      }
      files.push({
        externalSessionId,
        fileKey: entry.name.slice(0, -JSONL_EXTENSION.length),
        sourcePath: path.join(dirPath, entry.name),
      });
    }
  }
  return files;
}
