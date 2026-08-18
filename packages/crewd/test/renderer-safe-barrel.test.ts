/**
 * Boundary guard (FEA-3812, PR #3460 thread 1): the root barrel `@repo/crewd`
 * is advertised as renderer-safe, so nothing reachable from its *value* import
 * graph may pull in a `node:` builtin. The Node-only runnables (concrete harness
 * drivers, `defaultRegistry`, `runCascade`, `createDispatch`) live behind the
 * `@repo/crewd/harness` and `@repo/crewd/dispatch` subpaths precisely so they do
 * not leak `node:child_process`/`node:fs` into the desktop renderer bundle.
 *
 * This walks the real static import graph with the TypeScript compiler API (an
 * AST check, not a source-text scan): starting at `src/index.ts` it follows
 * every static `import`/`export ... from` specifier, resolving `./x.js` → the
 * on-disk `./x.ts`. A pure `import type` is erased at build and carries no
 * runtime code, so type-only edges are ignored. If any reachable module imports
 * a `node:` builtin as a value, the barrel is not renderer-safe and this fails.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");
const NODE_BUILTIN = /^node:/;
const JS_EXT = /\.js$/;

type ValueImport = { specifier: string; typeOnly: boolean };

function collectValueImports(file: string): ValueImport[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const out: ValueImport[] = [];
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        const typeOnly = stmt.importClause?.isTypeOnly ?? false;
        out.push({ specifier: spec.text, typeOnly });
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      const spec = stmt.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        out.push({ specifier: spec.text, typeOnly: stmt.isTypeOnly });
      }
    }
  }
  return out;
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null; // bare specifier (node: builtin or npm dep) — checked, not walked
  }
  const asTs = resolve(dirname(fromFile), specifier.replace(JS_EXT, ".ts"));
  return asTs;
}

function reachableValueGraph(entry: string): {
  files: Set<string>;
  nodeBuiltins: Map<string, string[]>;
} {
  const files = new Set<string>();
  const nodeBuiltins = new Map<string, string[]>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const imp of collectValueImports(file)) {
      if (imp.typeOnly) {
        continue; // erased at build — carries no runtime code
      }
      if (NODE_BUILTIN.test(imp.specifier)) {
        const hits = nodeBuiltins.get(file) ?? [];
        hits.push(imp.specifier);
        nodeBuiltins.set(file, hits);
        continue;
      }
      const local = resolveLocal(file, imp.specifier);
      if (local) {
        stack.push(local);
      }
    }
  }
  return { files, nodeBuiltins };
}

describe("renderer-safe root barrel", () => {
  it("reaches no node: builtin from @repo/crewd's value import graph", () => {
    const { nodeBuiltins } = reachableValueGraph(resolve(SRC, "index.ts"));
    const offenders = [...nodeBuiltins.entries()].map(
      ([file, specs]) => `${file.replace(SRC, "src")}: ${specs.join(", ")}`
    );
    expect(offenders).toEqual([]);
  });

  it("does NOT statically reach the Node-only harness exec module", () => {
    const { files } = reachableValueGraph(resolve(SRC, "index.ts"));
    const execReached = [...files].some((f) => f.endsWith("harness/exec.ts"));
    expect(execReached).toBe(false);
  });

  it("still exposes exec via the Node-only @repo/crewd/harness subpath", () => {
    // The concrete drivers must remain importable somewhere — just not from root.
    const { files } = reachableValueGraph(resolve(SRC, "harness/index.ts"));
    const execReached = [...files].some((f) => f.endsWith("harness/exec.ts"));
    expect(execReached).toBe(true);
  });
});
