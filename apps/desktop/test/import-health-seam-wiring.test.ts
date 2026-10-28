/**
 * @file import-health-seam-wiring.test.ts
 * @description ISS-8600 — pins the three production wirings that hand the
 * import-health tracker's occurrence sinks to the code that fires them.
 *
 * All three are OPTIONAL properties, two of them read off a nullable accessor,
 * so deleting any one of them leaves every behavioral suite green while the
 * fleet reports nothing for that signal — the exact shape ISS-8015 was opened
 * for. `collector-manager-watch-lost-wiring.test.ts` drives the two hops BELOW
 * the runtime (manager option → watcher option) and
 * `transcript-discovery-sweep-coverage.test.ts` drives the one below the
 * factory; this file pins the hops above them, which nothing can drive in
 * process — two build the whole Electron dashboard runtime, and the third
 * builds the transcript archive lane on top of it.
 *
 * Structural, on the resolved AST rather than on source text, following the
 * harness-progress pin in `import-stall-telemetry.test.ts`.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { test } from "vitest";
import {
  forEachNode,
  parseTypeScriptFile,
  propertyAccessPair,
  propertyInitializer,
} from "./helpers/ts-ast.js";

const SOURCE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "main"
);
const DASHBOARD_RUNTIME_PATH = path.join(
  SOURCE_ROOT,
  "dashboard",
  "agent-dashboard-design-system-runtime.ts"
);
const TRANSCRIPT_SYNC_FACTORY_PATH = path.join(
  SOURCE_ROOT,
  "transcript-sync",
  "desktop-transcript-sync-factory.ts"
);

/** The factory whose return value owns every import-health sink. */
const TRACKER_FACTORY = "installImportHealthTracking";
const COLLECTOR_MANAGER = "CollectorManager";
/** The type annotation on the local the dashboard runtime factory returns. */
const RUNTIME_TYPE = "AgentDashboardDesignSystemRuntime";
const WATCH_LOST_OPTION = "onWatchLost";
const WATCH_LOST_SINK = "noteWatchLost";
const MATERIALIZE_SINK = "noteMaterializeOutcome";
/** The live accessor the transcript lane resolves the runtime through. */
const RUNTIME_ACCESSOR = "getAgentDashboardRuntime";

test("ISS-8600: the dashboard runtime hands CollectorManager the tracker's watch-lost sink", () => {
  const source = parseTypeScriptFile(DASHBOARD_RUNTIME_PATH);

  // The RECEIVER is the half worth pinning. `onWatchLost` is optional and
  // harness-agnostic, so a wiring that forwarded some other callable would
  // still typecheck and still fire — and would ship no record, because only the
  // tracker maps the collector's key onto the contract's closed harness set.
  const tracker = trackerBindingName(source);
  assert.ok(tracker, `${TRACKER_FACTORY} must be bound to a local`);

  const managerOptions = collectorManagerOptions(source);
  assert.ok(managerOptions, `${COLLECTOR_MANAGER} must be constructed here`);

  const sink = propertyInitializer(managerOptions, WATCH_LOST_OPTION);
  assert.ok(sink, `${COLLECTOR_MANAGER} must be passed ${WATCH_LOST_OPTION}`);
  assert.deepEqual(propertyAccessPair(sink), {
    receiver: tracker,
    member: WATCH_LOST_SINK,
  });
});

test("ISS-8600: the dashboard runtime exposes the tracker's materialize sink", () => {
  const source = parseTypeScriptFile(DASHBOARD_RUNTIME_PATH);

  const tracker = trackerBindingName(source);
  assert.ok(tracker, `${TRACKER_FACTORY} must be bound to a local`);

  // Scoped to the RETURNED runtime object, not the file: the transcript lane
  // reads this sink off the runtime, so a property assigned anywhere else in
  // the module would satisfy a file-wide search while the lane found nothing.
  const runtime = runtimeDeclaration(source);
  assert.ok(runtime, `a local typed ${RUNTIME_TYPE} must be declared here`);

  const sink = propertyInitializer(runtime, MATERIALIZE_SINK);
  assert.ok(sink, `the runtime must expose ${MATERIALIZE_SINK}`);
  assert.deepEqual(propertyAccessPair(sink), {
    receiver: tracker,
    member: MATERIALIZE_SINK,
  });
});

test("ISS-8600: the transcript-sync factory reads the materialize sink off the runtime accessor", () => {
  const source = parseTypeScriptFile(TRANSCRIPT_SYNC_FACTORY_PATH);

  const sink = propertyInitializer(source, MATERIALIZE_SINK);
  assert.ok(sink, `the sweep must be passed ${MATERIALIZE_SINK}`);

  // Through the ACCESSOR, and lazily: the dashboard runtime does not exist when
  // this factory runs, so a wiring that captured it eagerly would bind null and
  // report nothing for the life of the process.
  assert.equal(
    callsMember(sink, RUNTIME_ACCESSOR),
    true,
    `${MATERIALIZE_SINK} must resolve the runtime through ${RUNTIME_ACCESSOR}()`
  );
  assert.equal(
    callsMember(sink, MATERIALIZE_SINK),
    true,
    `${MATERIALIZE_SINK} must call the runtime's own sink`
  );
});

/** The identifier `installImportHealthTracking(...)` is bound to. */
function trackerBindingName(source: ts.SourceFile): string | undefined {
  let binding: string | undefined;
  forEachNode(source, (node) => {
    if (!(ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))) {
      return;
    }
    const { initializer } = node;
    if (
      initializer &&
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === TRACKER_FACTORY
    ) {
      binding = node.name.text;
    }
  });
  return binding;
}

/** The object literal `new CollectorManager({...})` is constructed with. */
function collectorManagerOptions(
  source: ts.SourceFile
): ts.ObjectLiteralExpression | undefined {
  let options: ts.ObjectLiteralExpression | undefined;
  forEachNode(source, (node) => {
    if (
      !(ts.isNewExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== COLLECTOR_MANAGER
    ) {
      return;
    }
    const [argument] = node.arguments ?? [];
    if (argument && ts.isObjectLiteralExpression(argument)) {
      options = argument;
    }
  });
  return options;
}

/** The declaration of the local annotated `AgentDashboardDesignSystemRuntime`. */
function runtimeDeclaration(
  source: ts.SourceFile
): ts.VariableDeclaration | undefined {
  let declaration: ts.VariableDeclaration | undefined;
  forEachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node)) {
      return;
    }
    const { type } = node;
    if (
      type &&
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      type.typeName.text === RUNTIME_TYPE
    ) {
      declaration = node;
    }
  });
  return declaration;
}

/** Whether `root` calls `<anything>.<member>(...)` somewhere inside it. */
function callsMember(root: ts.Node, member: string): boolean {
  let found = false;
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === member
    ) {
      found = true;
    }
  });
  return found;
}
