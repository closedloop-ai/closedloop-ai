/**
 * ISS-9971 AC-4 — no surface declares its own dollar label string.
 *
 * The phrase "Total estimated cost" is declared ONCE, in
 * `packages/api/src/types/total-estimated-cost-copy.ts`; every surface that
 * renders it imports the constant. This walks every production module the
 * four surfaces render from and parses each with the TypeScript AST (the
 * sanctioned alternative to a raw-text scan), so a second declaration —
 * however it is quoted — fails here rather than drifting per surface.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CANONICAL_OWNER = "packages/api/src/types/total-estimated-cost-copy.ts";
const SURFACE_ROOTS = [
  "packages/api/src",
  "packages/app",
  "apps/app/app",
  "apps/app/components",
  "apps/desktop/src/renderer",
];
const SOURCE_EXTENSION_PATTERN = /\.tsx?$/;
const EXCLUDED_SEGMENT_PATTERN =
  /(^|\/)(__tests__|node_modules|dist|\.next)(\/|$)|\.(test|spec|stories)\.tsx?$|\.test-helpers\.tsx?$/;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(REPO_ROOT, path);
    if (EXCLUDED_SEGMENT_PATTERN.test(rel)) {
      continue;
    }
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (SOURCE_EXTENSION_PATTERN.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Every string or no-substitution template literal whose text is the phrase. */
function declaresThePhrase(path: string): boolean {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const wanted = TOTAL_ESTIMATED_COST_LABEL.toLowerCase();
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) {
      return;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.trim().toLowerCase() === wanted
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("ISS-9971 the dollar phrase has one owner", () => {
  // Parses every file under five roots: 8.8s under coverage on main (ISS-10512).
  it("is declared only in the canonical copy module across every rendering surface", () => {
    const files = SURFACE_ROOTS.flatMap((root) =>
      walk(resolve(REPO_ROOT, root), [])
    );
    expect(files.length).toBeGreaterThan(100);
    const declarers = files
      .filter(declaresThePhrase)
      .map((path) => relative(REPO_ROOT, path))
      .sort();
    expect(declarers).toEqual([CANONICAL_OWNER]);
  }, 60_000);
});
