/**
 * @file trusted-transcript-path-import-boundary.test.ts
 * @description FEA-3932: structural guard that `trusted-transcript-path.ts`
 * stays a LEAF module. It is on the desktop boot static-import graph (the
 * transcript hook anchor), so it must NOT statically import the collector graph
 * (`collectors/**`) or the materializer (which itself pulls the collector graph)
 * — that would defeat the agent-dashboard boundary the lazy `import()` of
 * discovery/materialization was designed to preserve. AST-based (import
 * specifiers only), so it is resilient to formatting and immune to comments.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SourceFile } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isImportDeclaration,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
} from "typescript6";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testDir, "..");
const trustedPathModule = path.join(
  desktopRoot,
  "src/main/transcript-sync/trusted-transcript-path.ts"
);

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "collectors/",
  "opencode-materializer",
  "opencode-materialized-discovery",
];

function collectStaticImportSpecifiers(sourceFile: SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: Parameters<typeof forEachChild>[0]): void => {
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

test("trusted-transcript-path.ts does not statically import the collector graph (FEA-3932)", () => {
  const sourceFile = createSourceFile(
    trustedPathModule,
    readFileSync(trustedPathModule, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  const specifiers = collectStaticImportSpecifiers(sourceFile);
  const offenders = specifiers.filter((spec) =>
    FORBIDDEN_IMPORT_SUBSTRINGS.some((forbidden) => spec.includes(forbidden))
  );
  assert.deepEqual(
    offenders,
    [],
    `trusted-transcript-path.ts must not statically import the collector graph; found: ${offenders.join(", ")}`
  );
  // Sanity: the guard actually parsed imports (not a no-op on an empty parse).
  assert.ok(specifiers.length > 0, "expected some import specifiers");
});
