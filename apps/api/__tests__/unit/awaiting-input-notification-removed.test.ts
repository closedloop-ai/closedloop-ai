import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

/**
 * FEA-3660: the "Session <id> needs your input" push/inbox notification is
 * removed as pure noise. It fired on every genuine null → non-null
 * awaiting-input transition (many per hour across a busy user's runs) and, for
 * unnamed runs, carried a raw `Session <externalId>` label — low signal, high
 * volume. The Active Runs surface already shows awaiting-input state visually,
 * so the redundant notification is dropped rather than merely debounced.
 *
 * These are structural guards (no DB, no Liveblocks) that pin the removal so
 * the notification cannot be silently reintroduced. Rather than grep the raw
 * source text (brittle: broken by renames, satisfiable by a comment — and a
 * pattern banned by AGENTS.md), they parse each module with the TypeScript
 * compiler API and assert on the resolved AST: the emitter modules are gone,
 * the session-sync service neither imports nor references the dispatcher, and
 * the shared inbox helper no longer exports the awaiting-input sender.
 */

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, "..", "..");

const SESSION_SERVICE_PATH = join(
  API_ROOT,
  "app",
  "agent-sessions",
  "service.ts"
);
const INBOX_NOTIFICATIONS_PATH = join(
  REPO_ROOT,
  "packages",
  "collaboration",
  "server",
  "inbox-notifications.ts"
);

/** Parse a TS module into an AST we can walk (comments do not become nodes). */
function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
}

/** Every identifier text that appears anywhere in the module's AST. */
function collectIdentifiers(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Names bound by a module's top-level import declarations. */
function collectImportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** Names a module exports (function/type/const declarations + export clauses). */
function collectExportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    const hasExportModifier = ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

    if (hasExportModifier) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        names.add(statement.name.text);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            names.add(declaration.name.text);
          }
        }
      }
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

describe("FEA-3660: awaiting-input notification removed", () => {
  it("deletes the awaiting-input notifier + transition modules", () => {
    expect(
      existsSync(join(API_ROOT, "lib", "awaiting-input-notifications.ts"))
    ).toBe(false);
    expect(
      existsSync(join(API_ROOT, "lib", "awaiting-input-transition.ts"))
    ).toBe(false);
  });

  it("session-sync neither imports nor references the notification dispatcher", () => {
    const source = parse(SESSION_SERVICE_PATH);
    const imported = collectImportedNames(source);
    const referenced = collectIdentifiers(source);

    for (const symbol of [
      "dispatchAwaitingInputNotification",
      "isAwaitingInputTransition",
      "awaitingInputTransitions",
    ]) {
      expect(imported.has(symbol)).toBe(false);
      expect(referenced.has(symbol)).toBe(false);
    }
  });

  it("drops the shared awaiting-input inbox sender from the exported surface", () => {
    const source = parse(INBOX_NOTIFICATIONS_PATH);
    const exported = collectExportedNames(source);

    expect(exported.has("sendAwaitingInputNotification")).toBe(false);
    expect(exported.has("AwaitingInputNotificationParams")).toBe(false);
  });
});
