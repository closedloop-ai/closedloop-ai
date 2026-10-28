/**
 * @file skill-files.ts — the leaf filesystem, deterministic-id and SKILL.md
 * frontmatter primitives every pack/definition scanner is built out of.
 *
 * Extracted from pack-scanner.ts (ISS-7686) for the reason claude-home.ts was
 * extracted before it: `marketplace-scan.ts` needs these primitives and
 * pack-scanner.ts calls into `marketplace-scan.ts`, so leaving them in
 * pack-scanner.ts would make those two modules import each other. Nothing here
 * knows about packs, marketplaces or a scan sink — it probes and parses.
 *
 * The `fs` calls stay synchronous: this is filesystem probing, not a hot path.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isTccProtectedPath } from "../../shared/sandbox-policy.js";

// Hoisted per Ultracite's `useTopLevelRegex`. Both are stateless (no `g`/`y`
// flag), so a single shared literal behaves exactly as the per-call ones did.
const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const LINE_BREAK_PATTERN = /\r?\n/;

// ---------------------------------------------------------------------------
// Filesystem helpers (sync — fine for probing)
// ---------------------------------------------------------------------------

export function safeStat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

// ISS-11914: the two readers below return nothing for a TCC-protected path,
// where listing or reading raises a macOS permission prompt. The pack scans and
// the recursive walker read through them.
export function safeReadDir(p: string) {
  if (isTccProtectedPath(p)) {
    return [];
  }
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function safeReadFile(p: string): string | null {
  if (isTccProtectedPath(p)) {
    return null;
  }
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function isSymlink(p: string): boolean {
  const st = safeStat(p);
  return !!st && st.isSymbolicLink();
}

// ---------------------------------------------------------------------------
// Deterministic IDs and frontmatter
// ---------------------------------------------------------------------------

export function deterministicSkillId(
  harness: string,
  installPath: string,
  name: string
): string {
  return createHash("sha256")
    .update(`${harness}|${installPath}|${name}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Parse YAML frontmatter from a SKILL.md file. Lenient: missing fields are
 * returned as null rather than throwing. Returns null when no frontmatter
 * block is present.
 */
/**
 * Unquote a YAML scalar value read from frontmatter.
 *
 * A double-quoted value (the form our writers emit via `JSON.stringify`, which
 * is a valid YAML double-quoted flow scalar) must be *unescaped*, not merely
 * stripped of its outer quotes — otherwise a name/description containing a quote
 * or backslash (e.g. `Deploy: production "now"`) round-trips back with literal
 * `\"`/`\\` in it. JSON string-escapes are a subset of YAML double-quote
 * escapes, so `JSON.parse` decodes them faithfully; we fall back to a plain
 * strip if the value is not valid JSON. Single-quoted scalars keep the simple
 * strip (YAML single quotes only escape `''`, which our writers never emit).
 */
function unquoteScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function parseSkillFrontmatter(
  content: string
): Record<string, string> | null {
  if (typeof content !== "string") {
    return null;
  }
  const match = content.match(FRONTMATTER_BLOCK_PATTERN);
  if (!match) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const rawLine of match[1].split(LINE_BREAK_PATTERN)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sep = line.indexOf(":");
    if (sep < 0) {
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    fields[key] = unquoteScalar(line.slice(sep + 1).trim());
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Recursive skill-file walker
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively (bounded depth) and yield every SKILL.md path.
 * Symlinks inside a pack are followed once; depth is capped to avoid runaway
 * traversal if a user has a weird layout.
 */
export function findSkillFiles(root: string, maxDepth = 6): string[] {
  const results: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) {
      continue;
    }
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(full);
      }
    }
  }
  return results;
}
