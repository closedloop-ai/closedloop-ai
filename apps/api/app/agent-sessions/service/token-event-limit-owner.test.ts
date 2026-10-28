/**
 * ISS-9857: the per-session token-event ceiling has ONE owner,
 * `@repo/api/src/types/agent-session-token-event-limits`. Before this ticket the
 * value was written out as `10_000` in two apps/api modules for the same lane,
 * so a change to one would have left the other serving a different bound.
 *
 * The runtime half proves the two apps/api names resolve to the owner's value.
 * The AST half proves HOW they got it: neither module may initialize its cap
 * name with a numeric literal, and both must import the owner module — a copy
 * that happens to equal 10,000 today would pass the runtime check and still be
 * the drift this guards against. Read through `ts.createSourceFile`, the
 * sanctioned form (`scripts/lint/rules/no-raw-text-source-scan.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { SESSION_TOKEN_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-token-event-limits";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS } from "./records";

const OWNER_MODULE = "@repo/api/src/types/agent-session-token-event-limits";

const CAP_NAMES: ReadonlySet<string> = new Set([
  "SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS",
  "SESSION_TOKEN_EVENT_MAX_ROWS",
]);

const CONSUMER_MODULES = ["records.ts", "session-usage-reads.ts"] as const;

function parse(fileName: string): ts.SourceFile {
  const filePath = path.join(import.meta.dirname, fileName);
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

/** Every `const <cap> = <numeric literal>` declaration in the file. */
function numericLiteralCapInitializers(sourceFile: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      CAP_NAMES.has(node.name.text) &&
      node.initializer !== undefined &&
      ts.isNumericLiteral(node.initializer)
    ) {
      found.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The module specifiers the file imports `SESSION_TOKEN_EVENT_MAX_ROWS` from. */
function ownerImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) {
      continue;
    }
    const importsOwner = bindings.elements.some(
      (element) =>
        (element.propertyName ?? element.name).text ===
        "SESSION_TOKEN_EVENT_MAX_ROWS"
    );
    if (importsOwner) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

describe("token-event cap single owner (ISS-9857)", () => {
  it("resolves both apps/api names to the owner's value", () => {
    expect(SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS).toBe(
      SESSION_TOKEN_EVENT_MAX_ROWS
    );
    expect(SESSION_TOKEN_EVENT_MAX_ROWS).toBe(10_000);
  });

  it.each(CONSUMER_MODULES)(
    "%s carries no numeric-literal initializer for a cap name",
    (fileName) => {
      expect(numericLiteralCapInitializers(parse(fileName))).toEqual([]);
    }
  );

  it.each(CONSUMER_MODULES)(
    "%s imports SESSION_TOKEN_EVENT_MAX_ROWS from the owner module",
    (fileName) => {
      expect(ownerImportSpecifiers(parse(fileName))).toEqual([OWNER_MODULE]);
    }
  );
});
