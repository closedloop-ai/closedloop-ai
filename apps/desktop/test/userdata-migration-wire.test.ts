/**
 * @file userdata-migration-wire.test.ts
 * @description ISS-8955 — pin the PRODUCTION wire that supplies the redirect
 * guard's `appName`.
 *
 * The guard skips the FEA-2101 migration whenever `userData` is not at
 * `<appData>/<appName>`. That is only correct if `appName` is byte-identical to
 * the name Electron actually joined onto `appData`, and `startup.ts` is its one
 * production supplier. Nothing else can catch a wrong value: the migration's own
 * suites inject `appName` themselves, so they stay green whatever startup passes.
 *
 * The failure mode is silent and total, in the dangerous direction. Pass the
 * LEGACY spelling — an easy slip in a change whose whole subject is `ClosedLoop`
 * versus `Closedloop` — or let a literal drift from `app.setName(...)`, and
 * `<appData>/<appName>` never equals `userData` on an ordinary launch, so every
 * legacy install takes `skipped-user-data-redirected` and the migration is dead
 * with no test and no error saying so.
 *
 * `run()` cannot be driven in a unit test (it registers Electron protocol
 * handlers, acquires the single-instance lock, and constructs the application),
 * so the invariant is pinned structurally, per AGENTS.md → "Test Practices":
 * parse the module with the TypeScript compiler API and assert on the resolved
 * AST, never on the raw source text.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript6";
import { test } from "vitest";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const STARTUP_PATH = join(import.meta.dirname, "../src/main/startup.ts");
const MIGRATION_CALLEE = "migrateLegacyUserDataDirectory";

test("startup supplies appName to the migration from app.getName(), never a literal", () => {
  const appNameArguments = migrationCallProperties("appName");

  assert.ok(
    appNameArguments.length > 0,
    `startup.ts must call ${MIGRATION_CALLEE}() with an options object`
  );
  for (const appNameArgument of appNameArguments) {
    assert.ok(
      appNameArgument,
      `every ${MIGRATION_CALLEE}() call must pass an \`appName\` property — without it the redirect guard cannot tell a chosen profile from the default one`
    );
    assert.ok(
      ts.isCallExpression(appNameArgument) &&
        ts.isPropertyAccessExpression(appNameArgument.expression) &&
        ts.isIdentifier(appNameArgument.expression.name) &&
        appNameArgument.expression.name.text === "getName",
      "appName must be `app.getName()` — a restated string literal drifts from the `app.setName` that actually decides the userData path, and a wrong value silently skips the migration for every legacy install"
    );
  }
});

test("startup reads appData for the migration rather than deriving it from userData", () => {
  const appDataArguments = migrationCallProperties("appDataPath");

  assert.ok(
    appDataArguments.length > 0,
    `startup.ts must call ${MIGRATION_CALLEE}() with an options object`
  );
  for (const appDataArgument of appDataArguments) {
    assert.ok(
      appDataArgument,
      `every ${MIGRATION_CALLEE}() call must pass \`appDataPath\``
    );
    assert.ok(
      ts.isCallExpression(appDataArgument) &&
        appDataArgument.arguments.length === 1 &&
        ts.isStringLiteral(appDataArgument.arguments[0]) &&
        appDataArgument.arguments[0].text === "appData",
      'appDataPath must come from `app.getPath("appData")`. Deriving it from `userData` instead would make the two sides of the guard move together, so a redirected profile would compare equal to its own parent and the guard would never fire — the exact defect ISS-8955 fixes'
    );
  }
});

/**
 * The `<name>:` initializer from EVERY migration call's options object, one
 * entry per call in source order — `undefined` where that call omits the
 * property. Per call rather than a single result: a second
 * `migrateLegacyUserDataDirectory(...)` in `startup.ts` would otherwise leave
 * the first one ungraded, which is the half a wrong `appName` would hide in.
 * Within one object literal the last assignment still wins, matching the
 * duplicate-key semantics the call itself would have at runtime.
 */
function migrationCallProperties(name: string): (ts.Expression | undefined)[] {
  const perCall: (ts.Expression | undefined)[] = [];
  forEachNode(parseTypeScriptFile(STARTUP_PATH), (node) => {
    if (
      !(
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === MIGRATION_CALLEE
      )
    ) {
      return;
    }
    const [options] = node.arguments;
    if (!(options && ts.isObjectLiteralExpression(options))) {
      perCall.push(undefined);
      return;
    }
    let initializer: ts.Expression | undefined;
    for (const property of options.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === name
      ) {
        initializer = property.initializer;
      }
    }
    perCall.push(initializer);
  });
  return perCall;
}
