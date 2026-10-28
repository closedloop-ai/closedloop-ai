/**
 * @file e2e-seam-packaging-gate-wiring.test.ts
 * @description ISS-10110 — pins the packaging dimension the main-process
 * composition root hands to both TEST-ONLY E2E seam gates.
 *
 * `isE2eParseQuarantineEnabled` (ISS-4573) and `e2eBootImportAbandonPasses`
 * (ISS-8982) are fail-closed as FUNCTIONS, and each has a unit case proving a
 * packaged build arms nothing. Neither pins the argument its production caller
 * supplies. Substituting a literal `false` for `app.isPackaged` in
 * `agent-dashboard-design-system-runtime.ts` left all 18 suites that reference
 * that runtime green at `d6aad2d538` — and the launched-app E2E cannot catch it
 * either, because the E2E build is itself unpackaged, so `false` is the value it
 * already observes. That substitution is what would arm a test-only seam inside
 * a SHIPPED client whenever the env sentinel is inherited, which is the whole
 * hazard the `isPackaged` dimension was added for.
 *
 * Structural, on the resolved AST rather than on source text, following
 * `import-health-seam-wiring.test.ts` over this same file: the composition root
 * cannot be driven in process (it builds the whole Electron dashboard runtime),
 * and `app.isPackaged` is readable only from the main process, so there is no
 * synthetic input that reaches this decision through a call.
 *
 * The gate names are IMPORTED rather than transcribed (`seam.name`), so
 * renaming either seam function without moving its call site reddens here
 * instead of silently matching nothing.
 *
 * A NAME IS NOT A BINDING (PR #7188 review, marisolashgrove and whitlockk). Matching
 * `app.isPackaged` somewhere in the file is satisfied by a parameter named
 * `app`, by an inner `const app = { isPackaged: false }`, and — one scope the
 * review did not reach — by a local of either SEAM's name shadowing its import.
 * All three compile clean (`biome.jsonc` has no `noShadow` rule) and all three
 * measured green against the name-matching version of this file. So the calls
 * and the receiver are resolved to their imports here: the three names must be
 * import-bound, and nothing inside the composition root may re-bind any of
 * them. Resolution is conservative — the absence of any competing binding in
 * the region, not a scope-accurate walk — which can only over-reject, and
 * over-rejection of a guard is a red a human reads.
 *
 * SCOPE. These cases pin: that each seam is called exactly once inside
 * `createAgentDashboardDesignSystemRuntime`; that the name is never referenced
 * except as a direct callee, so no alias can carry a second armed call past
 * that count; that the call takes both dimensions; that the second is
 * `app.isPackaged`; and that `app` and both seam names resolve to imports,
 * `app` specifically to Electron's. They say nothing about the first argument,
 * nor about which module each seam is imported FROM, nor about what either gate
 * does with what it is handed — `e2e-parse-quarantine-seam.test.ts` and
 * `e2e-boot-import-abandon-seam.test.ts` own that half.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { test } from "vitest";
import { e2eBootImportAbandonPasses } from "../src/main/collectors/engine/e2e-boot-import-abandon-seam.js";
import { isE2eParseQuarantineEnabled } from "../src/main/collectors/engine/e2e-parse-quarantine-seam.js";
import {
  forEachNode,
  parseTypeScriptFile,
  propertyAccessPair,
} from "./helpers/ts-ast.js";

const RUNTIME_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "main",
  "dashboard",
  "agent-dashboard-design-system-runtime.ts"
);

/** The Electron module the packaging signal must come from. */
const ELECTRON_MODULE = "electron";
/** The binding and member that together name the real packaging signal. */
const PACKAGING_SIGNAL = { receiver: "app", member: "isPackaged" };
/** Both dimensions: the env sentinel, then the packaging signal. */
const GATE_ARITY = 2;
/** The factory the gate calls must live inside, not merely share a file with. */
const COMPOSITION_ROOT = "createAgentDashboardDesignSystemRuntime";
/**
 * The test-only seam gates of the `gate(env, isPackaged)` shape.
 *
 * NOT every consumer of `app.isPackaged` at this composition root:
 * `resolveLoopbackListenerPort` (ISS-5723) reads the same signal there, as an
 * options field rather than a positional gate argument, and
 * `loopback-port-isolation.test.ts` owns it.
 */
const PACKAGING_GATED_SEAMS = [
  isE2eParseQuarantineEnabled,
  e2eBootImportAbandonPasses,
];

const RUNTIME_SOURCE = parseTypeScriptFile(RUNTIME_PATH);

for (const seam of PACKAGING_GATED_SEAMS) {
  test(`ISS-10110: the composition root gates ${seam.name} on app.isPackaged`, () => {
    const root = compositionRoot();
    assert.ok(root, `${COMPOSITION_ROOT} must be declared at ${RUNTIME_PATH}`);

    const calls = callArgumentsOf(root, seam.name);

    assert.equal(
      calls.length,
      1,
      `${seam.name} must be called exactly once inside ${COMPOSITION_ROOT}`
    );

    // That count sees DIRECT callees only, so on its own it does not catch a
    // second armed call reached through `const gate = <seam>; gate(env, false)`.
    // What rules that out is the name never appearing except as a callee, which
    // also makes the count above a count of every call in the module.
    assert.equal(
      nonCallUsesOf(RUNTIME_SOURCE, seam.name),
      0,
      `${seam.name} must only ever be CALLED — a re-binding, an alias, or a by-reference pass carries a call this suite cannot count`
    );

    const [args] = calls;
    assert.equal(
      args.length,
      GATE_ARITY,
      `${seam.name} must be passed both gate dimensions`
    );
    assert.deepEqual(
      propertyAccessPair(args[GATE_ARITY - 1]),
      PACKAGING_SIGNAL,
      `${seam.name} must be gated on ${PACKAGING_SIGNAL.receiver}.${PACKAGING_SIGNAL.member}, not a literal`
    );
  });
}

test("ISS-10110: the `app` those gates read is Electron's own, not a local stand-in", () => {
  const root = compositionRoot();
  assert.ok(root, `${COMPOSITION_ROOT} must be declared at ${RUNTIME_PATH}`);

  const electronNames = namedImports(RUNTIME_SOURCE)
    .filter((binding) => binding.module === ELECTRON_MODULE)
    .map((binding) => binding.name);

  assert.equal(
    electronNames.includes(PACKAGING_SIGNAL.receiver),
    true,
    `${PACKAGING_SIGNAL.receiver} must be imported from "${ELECTRON_MODULE}", got [${electronNames.join(", ")}]`
  );

  // The import alone proves only where a module-scope `app` comes from. A
  // parameter or an inner `const app = { isPackaged: false }` shadows it inside
  // the very function the gate calls live in, and reads as the real signal.
  assert.equal(
    localBindingNames(root).has(PACKAGING_SIGNAL.receiver),
    false,
    `${COMPOSITION_ROOT} must not re-bind ${PACKAGING_SIGNAL.receiver} — a local of that name shadows Electron's`
  );
});

test("ISS-10110: the gate callees are the imported seams, not local stand-ins", () => {
  const root = compositionRoot();
  assert.ok(root, `${COMPOSITION_ROOT} must be declared at ${RUNTIME_PATH}`);

  const importedNames = new Set(
    namedImports(RUNTIME_SOURCE).map((binding) => binding.name)
  );
  const localNames = localBindingNames(root);

  for (const seam of PACKAGING_GATED_SEAMS) {
    assert.equal(
      importedNames.has(seam.name),
      true,
      `${seam.name} must be import-bound at the composition root's module, not defined there`
    );
    assert.equal(
      localNames.has(seam.name),
      false,
      `${COMPOSITION_ROOT} must not re-bind ${seam.name} — a local of that name shadows the fail-closed seam`
    );
  }
});

/** The composition-root factory declaration — the region the gate calls must live in. */
function compositionRoot(): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  forEachNode(RUNTIME_SOURCE, (node) => {
    if (
      found === undefined &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === COMPOSITION_ROOT
    ) {
      found = node;
    }
  });
  return found;
}

/** Whether `node` is exactly `<callee>(…)` — a direct, unaliased call. */
function isCallOf(node: ts.Node, callee: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === callee
  );
}

/** The argument list of every `<callee>(...)` call under `root`. */
function callArgumentsOf(
  root: ts.Node,
  callee: string
): ts.NodeArray<ts.Expression>[] {
  const calls: ts.NodeArray<ts.Expression>[] = [];
  forEachNode(root, (node) => {
    if (isCallOf(node, callee)) {
      calls.push(node.arguments);
    }
  });
  return calls;
}

/**
 * How many times `name` is used under `root` as anything OTHER than a direct
 * callee. The import that binds it does not count; an argument of its own call
 * does.
 */
function nonCallUsesOf(root: ts.Node, name: string): number {
  let uses = 0;
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      return;
    }
    if (isCallOf(node, name)) {
      for (const argument of node.arguments) {
        walk(argument);
      }
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      uses += 1;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(root);
  return uses;
}

/** Every `import { … } from "<module>"` binding `source` introduces. */
function namedImports(
  source: ts.SourceFile
): { module: string; name: string }[] {
  const bindings: { module: string; name: string }[] = [];
  forEachNode(source, (node) => {
    if (
      !(
        ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      )
    ) {
      return;
    }
    const named = node.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push({
          module: node.moduleSpecifier.text,
          name: element.name.text,
        });
      }
    }
  });
  return bindings;
}

/** Every name `root` binds locally — anything that can shadow a module import. */
function localBindingNames(root: ts.Node): Set<string> {
  const names = new Set<string>();
  forEachNode(root, (node) => {
    const bound = localBindingName(node);
    if (bound !== undefined) {
      names.add(bound);
    }
  });
  return names;
}

/** The name `node` binds, when `node` is a declaration that binds an identifier. */
function localBindingName(node: ts.Node): string | undefined {
  if (
    !(
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node)
    )
  ) {
    return undefined;
  }
  if (node.name === undefined || !ts.isIdentifier(node.name)) {
    return undefined;
  }
  return node.name.text;
}
