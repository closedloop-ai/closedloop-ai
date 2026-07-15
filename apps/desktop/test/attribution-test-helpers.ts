/**
 * @file attribution-test-helpers.ts
 * @description Attribution-specific fixtures for the FEA-1459 attribution-accuracy
 * suites (split out under FEA-2235 D2): the Codex-rollout / raw-transcript writers,
 * the attribution constants, and an empty attribution cache. The generic
 * Claude-transcript writer and the fully-populated session builder are shared
 * collector-test fixtures and live in `normalized-session-test-utils.ts`
 * (`writeClaudeTranscript`, `makePopulatedSession`); import those from there.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_UUID = "22222222-2222-4222-8222-222222222222";
export const LARGE_CACHE_READ_TOKENS = 2_192_635_647;

export function writeRollout(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const filePath = path.join(dir, name);
  writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

/** Write a transcript file (raw JSONL) for extractTranscriptTokens tests. */
export function writeTranscriptFile(lines: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  const filePath = path.join(dir, "transcript.jsonl");
  writeFileSync(
    filePath,
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

export function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}
