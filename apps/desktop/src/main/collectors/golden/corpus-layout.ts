/**
 * @file corpus-layout.ts
 * @description Shared golden-corpus layout SSOT (FEA-2648). The dossier-directory
 * enumeration and raw-file classification are used by BOTH the Layer 1 golden
 * runner (`test/golden/golden-corpus.ts`) and the golden-mode collectors
 * (`golden-collectors.ts`), so the "what is a dossier / how do its raw files map
 * to a harness" rules live here once instead of being duplicated. Pure fs/path;
 * reading `normalized.json`/`expectations.yaml` is deliberately NOT here — that
 * is the Layer 1 runner's concern.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Directories under a corpus root that are scaffolding, not dossiers. The Layer
 * 1 runner skips these; staging never copies them.
 */
const NON_DOSSIER_DIRS: ReadonlySet<string> = new Set([
  "_templates",
  "collection-kit",
  "node_modules",
]);

export type DossierDir = {
  sessionId: string;
  /** Absolute path to the dossier directory (its name is the session id). */
  dir: string;
};

export type DossierRawDir = DossierDir & {
  /** Absolute path to the dossier's frozen `raw/` directory. */
  rawDir: string;
};

/**
 * Every dossier directory under a corpus root, sorted by session id. Skips the
 * non-dossier scaffolding, dot-directories, and non-directories — the exact skip
 * discipline the Layer 1 runner uses. A directory under the corpus IS a dossier;
 * incompleteness is the caller's assertion, not a silent skip here.
 */
export function listDossierDirs(root: string): DossierDir[] {
  if (!existsSync(root)) {
    return [];
  }
  const dirs: DossierDir[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (
      NON_DOSSIER_DIRS.has(name) ||
      name.startsWith(".") ||
      !statSync(dir).isDirectory()
    ) {
      continue;
    }
    dirs.push({ sessionId: name, dir });
  }
  return dirs;
}

/**
 * Every dossier paired with its frozen `raw/` directory (the corpus on-disk
 * layout: `<corpusDir>/<sessionId>/raw/`). Reading the oracle files under `dir`
 * (`normalized.json`, `expectations.yaml`) stays with the caller.
 */
export function listDossierRawDirs(corpusDir: string): DossierRawDir[] {
  return listDossierDirs(corpusDir).map((d) => ({
    ...d,
    rawDir: join(d.dir, "raw"),
  }));
}

export type RawFileClassification =
  | { kind: "opencode"; dbFile: string }
  | { kind: "codex"; parent: string; rollouts: string[] }
  | { kind: "claude"; main: string };

/**
 * Classify a dossier's raw files (basenames) into a harness parse plan:
 *   - a `.db` file      → opencode batch store;
 *   - `rollout-*.jsonl` → codex, with `parent` = the rollout whose name carries
 *                         the full session id (siblings are spawned-subagent
 *                         child rollouts, folded by the rollout graph);
 *   - otherwise         → claude main transcript `<sessionId>.jsonl`.
 *
 * Returns basenames; callers join them against the dossier's raw directory. A
 * codex dossier with no parent rollout, or a claude dossier missing its main
 * transcript, throws — an incomplete dossier must fail, never be skipped.
 */
export function classifyRawFiles(
  files: readonly string[],
  sessionId: string
): RawFileClassification {
  const sorted = [...files].sort();

  const dbFile = sorted.find((f) => f.endsWith(".db"));
  if (dbFile) {
    return { kind: "opencode", dbFile };
  }

  const rollouts = sorted.filter(
    (f) => f.startsWith("rollout-") && f.endsWith(".jsonl")
  );
  if (rollouts.length > 0) {
    const parent = rollouts.find((f) => f.includes(sessionId));
    if (!parent) {
      throw new Error(
        `${sessionId}: no parent rollout matching the full session id`
      );
    }
    return { kind: "codex", parent, rollouts };
  }

  const main = `${sessionId}.jsonl`;
  if (!sorted.includes(main)) {
    throw new Error(`${sessionId}: expected raw/${main} for a claude dossier`);
  }
  return { kind: "claude", main };
}
