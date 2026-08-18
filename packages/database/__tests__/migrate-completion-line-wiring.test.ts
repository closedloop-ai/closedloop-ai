/**
 * ISS-4601 AC #1, guarded at its PRODUCTION call site.
 *
 * The acceptance criterion is that a deploy which leaves an INVALID index no
 * longer reports unqualified success. `formatMigrateCompletionLine` implements
 * that and is unit-tested directly, but nothing asserted that `scripts/migrate.ts`
 * actually calls it: reverting either of its two terminal lines to the literal
 * `console.log("✓ Migrations completed successfully")` — the exact regression
 * this ticket exists to prevent — compiled, linted, and passed every test.
 *
 * `migrate.ts` cannot be imported to drive: it invokes `main()` at module scope
 * and terminates the process with `process.exit`, so loading it here would kill
 * the runner. Per AGENTS.md ("Test Practices") the sanctioned alternative to a
 * raw-text scan is parsing with `ts.createSourceFile` and asserting on the
 * resolved AST, which is what this does — it reads the shipped file and
 * evaluates the actual argument expression at each `console.log` call, so a
 * comment mentioning the helper cannot satisfy it.
 */

import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { parseMigrateScript } from "./test-helpers/migrate-script-ast";

const COMPLETION_HELPER = "formatMigrateCompletionLine";
// The pre-ISS-4601 wording, which claimed success without checking index state.
const UNQUALIFIED_SUCCESS_FRAGMENT = "Migrations completed";

type ConsoleLogArgument = {
  /** The called helper when the argument is a call, e.g. `format…(x)`. */
  calleeName: string | null;
  /** The literal text when the argument is a bare string. */
  literalText: string | null;
};

/** True for a `console.log(...)` callee specifically, not any bare `log(...)`. */
function isConsoleLogCallee(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "console" &&
    expression.name.text === "log"
  );
}

function describeArgument(argument: ts.Expression): ConsoleLogArgument {
  if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)) {
    return { calleeName: argument.expression.text, literalText: null };
  }
  if (
    ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument)
  ) {
    return { calleeName: null, literalText: argument.text };
  }
  return { calleeName: null, literalText: null };
}

function collectConsoleLogArguments(
  sourceFile: ts.SourceFile
): ConsoleLogArgument[] {
  const found: ConsoleLogArgument[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isConsoleLogCallee(node.expression) &&
      node.arguments.length > 0
    ) {
      found.push(describeArgument(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

describe("migrate.ts completion-line wiring (ISS-4601 AC #1)", () => {
  it("routes BOTH terminal success lines through formatMigrateCompletionLine", () => {
    const logs = collectConsoleLogArguments(parseMigrateScript());

    // One per auth path: the DATABASE_URL/password path and the IAM path.
    const throughHelper = logs.filter(
      (log) => log.calleeName === COMPLETION_HELPER
    );
    expect(throughHelper).toHaveLength(2);
  });

  it("never logs an unqualified completion claim as a bare literal", () => {
    const logs = collectConsoleLogArguments(parseMigrateScript());

    // This is the revert this guard exists to catch: a hardcoded
    // "✓ Migrations completed successfully" asserts a clean deploy without ever
    // consulting the sweep, which is precisely the false green of ISS-4601.
    const hardcodedClaims: string[] = [];
    for (const log of logs) {
      if (log.literalText?.includes(UNQUALIFIED_SUCCESS_FRAGMENT)) {
        hardcodedClaims.push(log.literalText);
      }
    }
    expect(hardcodedClaims).toEqual([]);
  });

  it("imports the helper it is asserted to call", () => {
    // Guards the other half of the revert: deleting the import fails the build,
    // but a same-named local stub would not, so pin the module it comes from.
    const sourceFile = parseMigrateScript();
    const importedFrom: string[] = [];
    ts.forEachChild(sourceFile, (node) => {
      if (
        !(
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
      ) {
        return;
      }
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.name.text === COMPLETION_HELPER) {
            importedFrom.push(node.moduleSpecifier.text);
          }
        }
      }
    });

    expect(importedFrom).toEqual(["./invalid-index-sweep"]);
  });
});
