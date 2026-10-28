/**
 * @file db-host-telemetry-relay-wiring.test.ts
 * @description ISS-7109 — the DB-host worker must actually INSTALL the telemetry
 * relay sink, at module scope.
 *
 * `db-host-child-telemetry-relay.test.ts` drives the sink factory and the whole
 * child → main route, but it installs the sink itself. Delete the one production
 * statement that installs it — `db-host-worker.ts`'s top-level
 * `setTelemetryRelaySink(createDbHostTelemetryRelaySink({ post, log: childLog }))`
 * — and that suite stays green while the shipped child emits into a null
 * transport exactly as it did before this fix. Which is the ISS-6417 failure
 * again, one level up: a correct helper nobody calls.
 *
 * The worker cannot be imported by a test (it registers a `process.parentPort`
 * listener at load), so this reads its AST — the same guard
 * `db-host-close-wiring.test.ts`, `db-host-invoke-dispatch.test.ts` and
 * `post-boot-maintenance-skill-inventory-order.test.ts` already apply to this
 * exact file for this exact reason.
 *
 * MODULE SCOPE is half the contract, not a detail. The sink's own doc says a
 * child that installs it late drops every event raised in the window before
 * installation; only a top-level statement is guaranteed to run before the Init
 * request opens the store.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, SourceFile } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { describe, test } from "vitest";

/** Hoisted per Ultracite `useTopLevelRegex`. */
const SHARED_SINK_FACTORY_RE = /createDbHostTelemetryRelaySink\(/;

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host/db-host-worker.ts"
);

function readWorkerSource(): SourceFile {
  return createSourceFile(
    WORKER_PATH,
    readFileSync(WORKER_PATH, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

/** Top-level `foo(...)` statements, as `[callee, argument text]` pairs. */
function readModuleScopeCalls(source: SourceFile): [string, string][] {
  const calls: [string, string][] = [];
  for (const statement of source.statements) {
    if (!isExpressionStatement(statement)) {
      continue;
    }
    const call: Node = statement.expression;
    if (!(isCallExpression(call) && isIdentifier(call.expression))) {
      continue;
    }
    calls.push([
      call.expression.getText(source),
      call.arguments.map((argument) => argument.getText(source)).join(", "),
    ]);
  }
  return calls;
}

/**
 * Callee names of every identifier-called function reached from a top-level
 * statement, in source order. Unlike {@link readModuleScopeCalls} this looks
 * inside variable initialisers, because the statements the install must precede
 * are `const x = f(...)` forms.
 */
function readTopLevelCallOrder(source: SourceFile): string[] {
  const calls: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      calls.push(node.expression.getText(source));
    }
    forEachChild(node, visit);
  };
  for (const statement of source.statements) {
    visit(statement);
  }
  return calls;
}

describe("db-host worker telemetry relay wiring", () => {
  test("installs the relay sink at module scope, built by the shared factory", () => {
    const calls = readModuleScopeCalls(readWorkerSource());
    const install = calls.find(
      ([callee]) => callee === "setTelemetryRelaySink"
    );
    assert.ok(
      install,
      "db-host-worker.ts must call setTelemetryRelaySink at MODULE SCOPE — " +
        "without it every event this process raises reaches a null transport " +
        "and is discarded, which is the whole of ISS-7109"
    );
    assert.match(
      install[1],
      SHARED_SINK_FACTORY_RE,
      "the sink must be the shared factory, not a second inline post closure — " +
        "an inline one would not carry the factory's never-throw guarantee, and " +
        "this reporter runs after the hook transaction has already committed"
    );
  });

  test("installs the sink before any module-scope work that can emit", () => {
    const calls = readTopLevelCallOrder(readWorkerSource());
    const installAt = calls.indexOf("setTelemetryRelaySink");
    assert.notEqual(installAt, -1);
    // Everything below the install can raise telemetry: the profiler, the op
    // lanes, and — through the Init request the listener at the bottom accepts —
    // the whole store. Pinning the order is what keeps the sink's own claim
    // true, that there is no window in which this process emits into the null
    // transport. Both markers are asserted present, so moving the install down
    // fails rather than skipping.
    for (const later of ["startDbHostProfiling", "createDbHostOpLanes"]) {
      const laterAt = calls.indexOf(later);
      assert.notEqual(laterAt, -1, `${later} is no longer at module scope`);
      assert.ok(
        installAt < laterAt,
        `the relay must be installed before ${later} runs`
      );
    }
  });
});
