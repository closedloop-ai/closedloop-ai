import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Every TypeScript extension a source file can carry.
 *
 * `.mts`/`.cts` are here because a guardrail's file filter is a silent skip
 * list: a module the walk does not return is not reported as unchecked, it is
 * reported as clean. None exist under `src` today, so this costs nothing now and
 * closes the hole before someone adds the first one.
 */
const TS_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Recursively collect TypeScript source file paths under `dir`, returning `[]`
 * when `dir` does not exist. Shared by the desktop source-scanning guardrail
 * tests (workspace-import-boundary, worker-entry-bundling,
 * browser-window-web-preferences-lock) so the walk lives in one place and the
 * callers cannot drift.
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
    } else if (TS_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}
