/**
 * @file codex-collector.ts
 * @description The per-harness collector descriptor for OpenAI Codex (FEA-1503).
 * The generic boot importer and the generic watcher drive Codex through this
 * uniform `HarnessCollector` shape: path/env resolution lives in `codex-home`,
 * format → NormalizedSession in `codex-parser`, and this descriptor wires them
 * together for the collector manager.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { findWorkflowJournals } from "../codex-workflow-scanner.js";
import type { HarnessCollector, NormalizedSession } from "../types.js";
import {
  getCodexArchivedDir,
  getCodexSessionsDir,
  listAllRolloutFiles,
  sessionIdFromRolloutPath,
} from "./codex-home.js";
import { parseRolloutFile } from "./codex-parser.js";

export function createCodexCollector(): HarnessCollector {
  return {
    key: "codex",
    cacheName: "codex",
    watchRoots(): string[] {
      // Recursive watch handled by the caller; Codex nests by date under here.
      return [getCodexSessionsDir()];
    },
    sourceRoots(): string[] {
      return [getCodexSessionsDir(), getCodexArchivedDir()];
    },
    watchMatch(filename: string): boolean {
      return filename.endsWith(".jsonl");
    },
    listSources(): string[] {
      return listAllRolloutFiles();
    },
    extraMtime: (source: string): number | null =>
      maxWorkflowJournalMtime(source),
    async parse(filePath: string): Promise<NormalizedSession[]> {
      const s = await parseRolloutFile(filePath);
      return s ? [s] : [];
    },
    sessionIdForSource(source: string): string | null {
      return sessionIdFromRolloutPath(source);
    },
  };
}

function maxWorkflowJournalMtime(source: string): number | null {
  let maxMtime: number | null = null;
  for (const journal of findWorkflowJournals(path.dirname(source))) {
    try {
      const mtime = statSync(journal).mtimeMs;
      maxMtime = maxMtime == null ? mtime : Math.max(maxMtime, mtime);
    } catch {
      /* race — ignore */
    }
  }
  return maxMtime;
}
