/**
 * @file parser-utils.ts
 * @description Re-export shim. The shared, browser-safe harness-parser utilities
 * (timestamp normalization, diff/line deltas, artifact-ref extraction,
 * byte-accurate `truncateText`, `shellCommand`/`shellCommandArgv`) were extracted
 * to the harness slice of `@repo/lib` (FEA-2717); this path stays stable for
 * their desktop consumers. The one util that CANNOT move — `collectJsonlFiles`,
 * the recursive JSONL file walker built on `node:fs`/`node:path` that the codex
 * and cursor collectors use to enumerate transcript files (FEA-2821) — stays
 * desktop-local below, so the browser package keeps zero Node dependencies.
 */
import fs from "node:fs";
import path from "node:path";

// biome-ignore lint/performance/noBarrelFile: re-export shim for the extracted @repo/lib/harness module (FEA-2717); collectJsonlFiles (fs walker) stays local
export * from "@repo/lib/harness/parser-utils";

/**
 * Recursively collect every `*.jsonl` file under a root directory. Harness
 * collectors (Codex rollouts, Cursor transcripts) each nest their JSONL under
 * a harness-specific layout, but the walk is generic. Depth-bounded
 * (`maxDepth`, default 8) and error-tolerant — the roots are the user's own
 * local data, so a permission or IO error on one branch must not abort
 * discovery. A missing/empty root yields `[]`.
 *
 * Desktop-only: it reads the local filesystem, so it stays here rather than in
 * the browser-safe harness slice of `@repo/lib` (FEA-2717/FEA-2821).
 */
export function collectJsonlFiles(
  root: string,
  { maxDepth = 8 }: { maxDepth?: number } = {}
): string[] {
  const out: string[] = [];
  if (!(root && fs.existsSync(root))) {
    return out;
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}
