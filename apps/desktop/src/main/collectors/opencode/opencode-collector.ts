/**
 * @file opencode-collector.ts
 * @description The OpenCode HarnessCollector (FEA-1503). OpenCode is a BATCH
 * harness: its canonical store is a single foreign SQLite DB (`opencode.db`),
 * read in one load. To avoid re-loading the whole DB on every catchup tick, the
 * collector self-fingerprints the DB + WAL/SHM siblings (name:mtimeMs:size) and
 * skips the load when the fingerprint is unchanged.
 *
 * Fingerprint logic ported from `scripts/agent-monitor-opencode/opencode-import.js`
 * (FEA-1316 / FEA-1334), logic preserved: the in-memory high-water-mark is
 * seeded from a persisted file so a fresh process also skips the cold-start load
 * when the DB is untouched. Only the fingerprint/idempotency concern is ported —
 * the dbModule write path stays in the shared `importSession` write-sink.
 */
import fs from "node:fs";
import path from "node:path";
import type { HarnessCollector, NormalizedSession } from "../types.js";
import {
  getOpenCodeDbPath,
  getOpenCodeDbWatchFiles,
  getOpenCodeHome,
} from "./opencode-home.js";
import { loadSessionsFromDb } from "./opencode-parser.js";

export function createOpencodeCollector(opts?: {
  fingerprintPath?: string;
}): HarnessCollector {
  const fingerprintPath = opts?.fingerprintPath;
  let lastFingerprint: string | null = null;
  let seeded = false;

  function loadPersistedFingerprint(): string | null {
    if (!fingerprintPath) {
      return null;
    }
    try {
      return fs.readFileSync(fingerprintPath, "utf8");
    } catch {
      return null;
    }
  }

  function persistFingerprint(fingerprint: string): void {
    if (!fingerprintPath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(fingerprintPath), { recursive: true });
      fs.writeFileSync(fingerprintPath, fingerprint);
    } catch {
      /* best-effort — an unwritable state dir just costs one extra load */
    }
  }

  function ensureSeeded(): void {
    if (seeded) {
      return;
    }
    seeded = true;
    lastFingerprint = loadPersistedFingerprint();
  }

  function fingerprintDbFiles(): string {
    const home = getOpenCodeHome();
    const parts: string[] = [];
    for (const name of getOpenCodeDbWatchFiles()) {
      try {
        const stat = fs.statSync(path.join(home, name));
        parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }
    return parts.join("|");
  }

  return {
    key: "opencode",
    cacheName: "opencode",
    batch: true,

    watchRoots(): string[] {
      return [getOpenCodeHome()];
    },

    watchMatch(filename: string): boolean {
      return getOpenCodeDbWatchFiles().some(
        (n) => filename === n || filename.endsWith(`/${n}`)
      );
    },

    sourcePathsForWatchEvent(): string[] {
      return [getOpenCodeDbPath()];
    },

    listSources(): string[] {
      ensureSeeded();
      const dbPath = getOpenCodeDbPath();
      if (!fs.existsSync(dbPath)) {
        return [];
      }
      const fingerprint = fingerprintDbFiles();
      if (fingerprint === lastFingerprint) {
        return [];
      }
      return [dbPath];
    },

    parse(dbPath: string): Promise<NormalizedSession[]> {
      return Promise.resolve(loadSessionsFromDb(dbPath));
    },

    sourceFingerprint(): string {
      return fingerprintDbFiles();
    },

    markSourceImported(_source, snapshot): void {
      const currentFingerprint = fingerprintDbFiles();
      if (
        snapshot?.fingerprint &&
        snapshot.fingerprint !== currentFingerprint
      ) {
        return;
      }
      lastFingerprint = snapshot?.fingerprint ?? currentFingerprint;
      persistFingerprint(lastFingerprint);
    },

    resetIngestState(): void {
      lastFingerprint = null;
      seeded = false;
      if (!fingerprintPath) {
        return;
      }
      try {
        fs.rmSync(fingerprintPath, { force: true });
      } catch {
        /* best-effort — an uncleared fingerprint only costs another explicit reset */
      }
    },

    /**
     * FEA-1785: Return the DB path unconditionally (bypassing the fingerprint
     * gate in listSources) so the data-revision rebuild can re-derive stale
     * opencode sessions even when the underlying DB hasn't changed.
     */
    listSourcesForRebuild(): string[] {
      const dbPath = getOpenCodeDbPath();
      if (!fs.existsSync(dbPath)) {
        return [];
      }
      return [dbPath];
    },
  };
}
