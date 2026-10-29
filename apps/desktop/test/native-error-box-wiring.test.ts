/**
 * ISS-12135: a fatal-error box in an off-screen test launch goes to stderr, not
 * to a native modal on whatever screen the machine has. The presenter decides;
 * the wiring half holds every `dialog.showErrorBox` in the main process to the
 * one module that routes through it.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, test } from "vitest";
import { createCrashDialogPresenter } from "../src/main/lifecycle/crash-dialog-presenter.js";
import { E2E_NO_REVEAL_ARG } from "../src/main/lifecycle/window-reveal-suppression.js";
import { collectTsFiles } from "./helpers/collect-ts-files.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SCANNED_DIRS = ["src/main", "src/server"];
const ROUTED_MODULE = "src/main/lifecycle/native-error-box.ts";
/**
 * Direct calls that predate this guard, which may only shrink. `app.ts`'s
 * update-blocked box is reached only by a packaged build, where the presenter
 * shows the box unchanged, and `app.ts` is grandfathered shrink-only.
 */
const KNOWN_DIRECT_CALLERS = ["src/main/app.ts"];
const TITLE = "Closedloop encountered a fatal error";
const BODY = "An unexpected error occurred.";

describe("crash dialog presenter (ISS-12135)", () => {
  test("an off-screen unpackaged launch writes the box to stderr and shows nothing", () => {
    const calls = recordingDeps([
      "/electron",
      "dist/main/index.js",
      E2E_NO_REVEAL_ARG,
    ]);

    createCrashDialogPresenter(calls.deps)(TITLE, BODY);

    assert.deepEqual(calls.shown, []);
    assert.deepEqual(calls.stderr, [`${TITLE}\n${BODY}\n`]);
  });

  test("an ordinary launch shows the box", () => {
    const calls = recordingDeps(["/electron", "dist/main/index.js"]);

    createCrashDialogPresenter(calls.deps)(TITLE, BODY);

    assert.deepEqual(calls.shown, [[TITLE, BODY]]);
    assert.deepEqual(calls.stderr, []);
  });

  test("a packaged build shows the box even when handed the test argument", () => {
    const calls = recordingDeps(["/Closedloop", E2E_NO_REVEAL_ARG], true);

    createCrashDialogPresenter(calls.deps)(TITLE, BODY);

    assert.deepEqual(calls.shown, [[TITLE, BODY]]);
    assert.deepEqual(calls.stderr, []);
  });
});

describe("native error box wiring (ISS-12135)", () => {
  const callers = SCANNED_DIRS.flatMap((dir) =>
    collectTsFiles(path.join(DESKTOP_ROOT, dir))
  )
    .filter(
      (file) => countDialogShowErrorBoxCalls(parseTypeScriptFile(file)) > 0
    )
    .map((file) => path.relative(DESKTOP_ROOT, file).split(path.sep).join("/"))
    .sort();

  test("only the routed module and the known callers call dialog.showErrorBox", () => {
    assert.deepEqual(
      callers,
      [...KNOWN_DIRECT_CALLERS, ROUTED_MODULE].sort(),
      `call showNativeErrorBox from ${ROUTED_MODULE} instead of dialog.showErrorBox`
    );
  });

  test("the crash paths reach the box through the routed module", () => {
    // The scan above is satisfied by deleting a call; this pins that the two
    // crash paths still present one, through the module that can suppress it.
    for (const entry of ["src/main/index.ts", "src/main/startup.ts"]) {
      assert.ok(
        importsShowNativeErrorBox(
          parseTypeScriptFile(path.join(DESKTOP_ROOT, entry))
        ),
        `${entry} no longer imports showNativeErrorBox`
      );
    }
  });
});

function recordingDeps(argv: string[], isPackaged = false) {
  const shown: [string, string][] = [];
  const stderr: string[] = [];
  return {
    shown,
    stderr,
    deps: {
      argv,
      isPackaged,
      showErrorBox: (title: string, body: string) => {
        shown.push([title, body]);
      },
      writeStderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function countDialogShowErrorBoxCalls(source: ts.SourceFile): number {
  let count = 0;
  forEachNode(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "showErrorBox" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "dialog"
    ) {
      count += 1;
    }
  });
  return count;
}

function importsShowNativeErrorBox(source: ts.SourceFile): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./lifecycle/native-error-box.js" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === "showNativeErrorBox"
      )
  );
}
