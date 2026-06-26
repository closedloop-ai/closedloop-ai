/**
 * @file cursor-collector.ts
 * @description Cursor harness collector descriptor (FEA-1503). Drives the
 * generic boot importer / watcher through the uniform `HarnessCollector` shape:
 * `home` (path/env resolution via cursor-home) + `parser` (transcript JSONL →
 * NormalizedSession via cursor-parser) + this small descriptor.
 */
import type { HarnessCollector, NormalizedSession } from "../types.js";
import {
  getCursorProjectsDir,
  listAllTranscriptFiles,
  sessionIdFromTranscriptPath,
} from "./cursor-home.js";
import { parseTranscriptFile } from "./cursor-parser.js";

export function createCursorCollector(): HarnessCollector {
  return {
    key: "cursor",
    cacheName: "cursor",
    watchRoots(): string[] {
      return [getCursorProjectsDir()];
    },
    watchMatch(filename: string): boolean {
      return filename.endsWith(".jsonl");
    },
    listSources(): string[] {
      return listAllTranscriptFiles();
    },
    async parse(filePath: string): Promise<NormalizedSession[]> {
      const s = await parseTranscriptFile(filePath);
      return s ? [s] : [];
    },
    sessionIdForSource(source: string): string | null {
      return sessionIdFromTranscriptPath(source);
    },
  };
}
