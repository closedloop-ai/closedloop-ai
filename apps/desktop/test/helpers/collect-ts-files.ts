import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Recursively collect `.ts`/`.tsx` file paths under `dir`, returning `[]` when
 * `dir` does not exist. Shared by the desktop source-scanning guardrail tests
 * (workspace-import-boundary, worker-entry-bundling) so the walk lives in one
 * place and the two callers cannot drift.
 */
export function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}
