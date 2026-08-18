import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript6";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

// ISS-5300 (PRD-618): the seven `src/main/ipc/*-ipc.ts` registrars this PR
// covers are each exercised by their own suite against a fake registrar. Those
// suites all stay green if a call site in the composition root is deleted or
// never added — the root AGENTS.md rule "test the production wiring, not only
// the unit". This pins the wiring itself.
//
// Structural, not behavioural, because importing `desktop-ipc-registration.ts`
// evaluates Electron bootstrap. AGENTS.md forbids regexing raw source for this
// (`scripts/lint/rules/no-raw-text-source-scan.ts`); the sanctioned route is the
// TypeScript AST, via the shared `test/helpers/ts-ast.ts` plumbing.
//
// It COUNTS rather than merely finds. A presence check ("is this registrar
// called?") cannot catch the double-registration bug, and Electron's real
// `ipcMain.handle` throws on a second handler for a channel — so a registrar
// wired twice crashes the app at boot while a presence assertion stays green.
//
// Counting also has to be AST-based rather than textual for a reason visible in
// this very file: `registerLogsActivityIpcHandlers` and
// `registerManagedKeyHintIpcHandlers` each appear a THIRD time in the source, in
// the JSDoc at :232-234 that documents them as deliberately ungated. `ts.forEachChild`
// does not descend into JSDoc, so the AST sees the import and the call and not
// the prose — a `grep -c` would read 3 and be wrong.

const REGISTRATION_MODULE = join(
  import.meta.dirname,
  "../src/main/ipc/desktop-ipc-registration.ts"
);

/** The registrars ISS-5300 covers with a dedicated suite. */
const COVERED_REGISTRARS = [
  "registerApprovalsIpcHandlers",
  "registerBinaryPathsIpcHandlers",
  "registerCloudControlIpcHandlers",
  "registerCommandSigningKeysIpcHandlers",
  "registerCostReconciliationIpcHandlers",
  "registerLogsActivityIpcHandlers",
  "registerManagedKeyHintIpcHandlers",
] as const;

/** The function that actually performs registration at boot. */
const REGISTRATION_FUNCTION = "registerAllDesktopIpcHandlers";

/**
 * The ISS-6206 deps builder. Its binding of each getter to a store is executed
 * by `cloud-read-readiness-projection.test.ts`; this file only pins that the
 * composition root goes through it.
 */
const PROJECTOR_DEPS_BUILDER = "buildCloudReadReadinessProjectorDeps";

/**
 * The body of {@link REGISTRATION_FUNCTION}. Counting over the whole SourceFile
 * would accept a registrar called from anywhere in the module — dead code, a
 * helper nothing reaches — and still report the wiring as sound. Scoping the
 * walk to the boot function is what makes the count mean "registered at boot".
 */
function registrationFunctionBody(root: ts.SourceFile): ts.Node {
  let found: ts.Node | undefined;
  forEachNode(root, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === REGISTRATION_FUNCTION &&
      node.body
    ) {
      found = node.body;
    }
  });
  if (!found) {
    throw new Error(
      `${REGISTRATION_FUNCTION} not found in desktop-ipc-registration.ts — the wiring guard is pointed at the wrong function`
    );
  }
  return found;
}

function countDirectCalls(scope: ts.Node, calleeName: string): number {
  let count = 0;
  forEachNode(scope, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === calleeName) {
      count += 1;
    }
  });
  return count;
}

function importedNames(root: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  forEachNode(root, (node) => {
    if (!ts.isImportSpecifier(node)) {
      return;
    }
    names.add(node.name.text);
  });
  return names;
}

/**
 * The name of the function called to produce `calleeName`'s only argument, or
 * `null` when that argument is anything else — an object literal, a variable, a
 * member expression. Deliberately NOT a property-name walk: a literal's keys say
 * what the deps are CALLED, never where their values come from, which is the
 * whole distinction this guard got wrong once already.
 */
function soleCallArgumentCallee(
  scope: ts.Node,
  calleeName: string
): string | null {
  let found: string | null = null;
  forEachNode(scope, (node) => {
    if (
      !(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== calleeName
    ) {
      return;
    }
    const [argument] = node.arguments;
    if (
      argument &&
      ts.isCallExpression(argument) &&
      ts.isIdentifier(argument.expression)
    ) {
      found = argument.expression.text;
    }
  });
  return found;
}

describe("desktop IPC registration wiring (ISS-5300)", () => {
  const source = parseTypeScriptFile(REGISTRATION_MODULE);
  const bootScope = registrationFunctionBody(source);

  test("every covered registrar is imported by the composition root", () => {
    const imported = importedNames(source);
    const missing = COVERED_REGISTRARS.filter((name) => !imported.has(name));
    assert.deepEqual(
      missing,
      [],
      `composition root does not import: ${missing.join(", ")}`
    );
  });

  for (const registrar of COVERED_REGISTRARS) {
    test(`${registrar} is invoked exactly once at boot`, () => {
      const calls = countDirectCalls(bootScope, registrar);
      // 0 => the handler group is dead: its own suite still passes while no
      // channel is registered in the running app.
      // >1 => registered twice; Electron's ipcMain.handle throws on a duplicate
      // channel, so the app fails at boot.
      assert.equal(
        calls,
        1,
        `${registrar} is called ${calls} time(s) in desktop-ipc-registration.ts; expected exactly 1`
      );
    });
  }

  test("the readiness projector's getters come from the tested builder, never a literal here (ISS-6206)", () => {
    // This guard used to read the property NAMES off an object literal passed
    // here and call that "wired to live getters". It was not: rewriting the
    // settings entry as `getTranscriptSyncEnabled: () => false`, or as a value
    // captured once at boot and returned from a thunk, kept the same three names
    // in the same order and left every suite green — while every install
    // reported the transcript lane `disabled_by_config`. A name is not a source.
    //
    // Both bindings are now executed by `cloud-read-readiness-projection.test.ts`
    // against a fake settings store. What only THIS file can see is that the
    // shipped app routes through that tested builder rather than re-deriving the
    // deps in a literal Electron alone can reach — so the assertion is exactly
    // that, and no longer overstates what a structural walk can prove.
    assert.ok(
      importedNames(source).has(PROJECTOR_DEPS_BUILDER),
      `composition root does not import ${PROJECTOR_DEPS_BUILDER}`
    );
    assert.equal(
      countDirectCalls(bootScope, "createCloudReadReadinessProjector"),
      1,
      "the readiness handler must come from the shared projector, not a second copy of its rules"
    );
    assert.equal(
      soleCallArgumentCallee(bootScope, "createCloudReadReadinessProjector"),
      PROJECTOR_DEPS_BUILDER,
      `the projector's deps must be built by ${PROJECTOR_DEPS_BUILDER}; an object literal here puts the binding back where no test can execute it`
    );
  });

  test("the counting walk sees call sites only — not prose, not imports", () => {
    // Guards the guard, and only where the loop above cannot. A name present in
    // the module solely as prose must count zero: `registerLogsActivityIpcHandlers`
    // is mentioned a third time in the :232-234 JSDoc, so a walk that ever
    // started reading comments would inflate counts and the exactly-once
    // assertions would keep passing for the wrong reason.
    assert.equal(countDirectCalls(bootScope, "deliberately"), 0);
    // Imported but never called from the boot function must also count zero —
    // an import alone is not wiring.
    assert.equal(countDirectCalls(bootScope, "WebContents"), 0);
  });
});
