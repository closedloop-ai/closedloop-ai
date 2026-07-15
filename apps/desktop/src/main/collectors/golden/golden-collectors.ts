/**
 * @file golden-collectors.ts
 * @description Golden-mode corpus staging + collector construction (FEA-2648).
 *
 * The frozen golden corpus is human-owned and must never be opened in place: a
 * read of a WAL-mode SQLite store creates `-wal`/`-shm` siblings, and the
 * opencode loader opens read-write. So golden mode first STAGES every dossier's
 * raw inputs into a throwaway tree under the golden profile, then points the
 * REAL harness collectors at the staged tree via their source/root overrides.
 * The collectors only ever read the staging tree; the corpus is copied exactly
 * once, by {@link stageGoldenCorpus}.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { canonicalizePathForPolicy } from "../../../server/security.js";
import { pathsOverlap } from "../../golden-mode.js";
import { createClaudeCollector } from "../claude/claude-collector.js";
import { createCodexCollector } from "../codex/codex-collector.js";
import { createOpencodeCollector } from "../opencode/opencode-collector.js";
import type { HarnessCollector } from "../types.js";
import {
  classifyRawFiles,
  listDossierDirs,
  listDossierRawDirs,
} from "./corpus-layout.js";

/**
 * Copy every dossier's `raw/` into `<stagingDir>/<sessionId>/`. Idempotent: the
 * staging tree is deleted and recreated on every call, so a dossier removed from
 * the corpus cannot linger across relaunches. The frozen corpus is only read
 * (the cpSync source); the collectors never touch it.
 *
 * `stagingDir` is caller-provided; as a hard safety net it must be disjoint from
 * `corpusDir` in both directions — we never write into the corpus, and the
 * `rmSync` wipe must never reach it. (The golden-mode config validation in
 * `golden-mode.ts` is the primary guard; this is defense in depth.)
 */
export function stageGoldenCorpus(corpusDir: string, stagingDir: string): void {
  assertDisjoint(corpusDir, stagingDir);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  for (const { sessionId, rawDir } of listDossierRawDirs(corpusDir)) {
    if (!existsSync(rawDir)) {
      // An incomplete dossier must fail, never be silently skipped — a skip
      // would render a corpus that quietly disagrees with the dossier list.
      throw new Error(
        `golden dossier ${sessionId} has no raw/ directory: ${rawDir}`
      );
    }
    cpSync(rawDir, path.join(stagingDir, sessionId), { recursive: true });
  }
}

/**
 * Build the real harness collectors over a staged corpus tree. Only the harness
 * kinds actually present are instantiated (the corpus has no cursor/copilot
 * dossiers, so those collectors are never built). Sources become admissible by
 * root containment alone — the staged paths sit under the overridden
 * roots/sources — so no `allowUnscopedSourceAdmission` escape hatch is used.
 *
 * Codex and opencode persistence paths are left at their defaults (undefined),
 * so neither the rollout-linkage cache nor the opencode fingerprint is written
 * anywhere outside the golden profile — a one-shot boot import needs neither.
 */
export function createGoldenCollectors(stagingDir: string): HarnessCollector[] {
  const claudeMainSources: string[] = [];
  const codexRolloutSources: string[] = [];
  const opencodeDataDirs: string[] = [];

  for (const { sessionId, dir } of listDossierDirs(stagingDir)) {
    // Staging flattened each dossier's raw/ into <stagingDir>/<sessionId>, so
    // the session dir itself holds the raw files to classify.
    const classification = classifyRawFiles(readdirSync(dir), sessionId);
    if (classification.kind === "opencode") {
      if (classification.dbFile !== "opencode.db") {
        // The opencode collector resolves exactly <dataDir>/opencode.db; any
        // other basename would be silently omitted from the import.
        throw new Error(
          `golden dossier ${sessionId}: opencode db must be named opencode.db (found ${classification.dbFile})`
        );
      }
      opencodeDataDirs.push(dir);
    } else if (classification.kind === "codex") {
      for (const rollout of classification.rollouts) {
        codexRolloutSources.push(path.join(dir, rollout));
      }
    } else {
      claudeMainSources.push(path.join(dir, classification.main));
    }
  }

  const collectors: HarnessCollector[] = [];
  if (claudeMainSources.length > 0) {
    collectors.push(
      createClaudeCollector({
        listSources: () => [...claudeMainSources],
        watchRoots: () => [stagingDir],
      })
    );
  }
  if (codexRolloutSources.length > 0) {
    // All rollouts (roots + child subagent rollouts) are fed in; the collector's
    // own rollout graph selects roots and folds descendants, exactly as in prod.
    collectors.push(
      createCodexCollector({
        listSources: () => [...codexRolloutSources],
        sessionsDir: stagingDir,
        archivedDir: stagingDir,
      })
    );
  }
  if (opencodeDataDirs.length > 1) {
    // CollectorManager keys its bookkeeping maps by collector.key, so two
    // "opencode" collectors would silently collide. The corpus has exactly one
    // opencode dossier today; multi-dossier support means teaching the opencode
    // collector multiple data dirs, not stacking same-key collectors.
    throw new Error(
      `golden corpus has ${opencodeDataDirs.length} opencode dossiers but the opencode collector supports one data dir; extend CreateOpencodeCollectorOptions before adding more`
    );
  }
  for (const dataDir of opencodeDataDirs) {
    collectors.push(createOpencodeCollector({ dataDir }));
  }
  return collectors;
}

function assertDisjoint(corpusDir: string, stagingDir: string): void {
  // Realpath canonicalization (not just resolve): a symlinked staging dir must
  // not defeat the guard — the rmSync wipe can never reach corpus bytes.
  const corpus = canonicalizePathForPolicy(corpusDir);
  const staging = canonicalizePathForPolicy(stagingDir);
  if (pathsOverlap(staging, corpus)) {
    throw new Error(
      `golden staging dir must be disjoint from the corpus dir (staging=${staging}, corpus=${corpus})`
    );
  }
}
