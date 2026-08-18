import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  CallExpression,
  Node,
  PropertyName,
  SourceFile,
} from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { DesktopSyncBatchOutcome } from "../src/main/telemetry/app-otel-runtime.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testDir, "..");
// The telemetry producers now live in THREE modules, and both extractions that
// put them there landed independently:
//   - ISS-6031 moved the pre-send disposition paths (absent / idle / oversized)
//     into `agent-session-sync-dispositions.ts`, taking two `dead_letter`
//     emissions with them;
//   - ISS-5988 goal stage 2 moved the accepted-ack producers into
//     `agent-session-sync-accepted-ack.ts`, taking three more.
// Scanning only the service would silently stop covering either group — the
// guard would keep passing while the code it exists to police left its field of
// view. So the producer set is a LIST, and every module that emits a sync
// outcome belongs on it.
const syncProducerPaths = [
  path.join(desktopRoot, "src/main/agent-sync/agent-session-sync-service.ts"),
  path.join(
    desktopRoot,
    "src/main/agent-sync/agent-session-sync-dispositions.ts"
  ),
  path.join(
    desktopRoot,
    "src/main/agent-sync/agent-session-sync-accepted-ack.ts"
  ),
];
const syncServiceTestPath = path.join(
  desktopRoot,
  "test/agent-session-sync-service.test.ts"
);
const producerCallbackNames = new Set([
  "onBatchOutcome",
  "onSyncBatchTelemetry",
  // Both extracted modules reach the telemetry sink through an injected
  // collaborator rather than `this.options`, so each makes a call named for its
  // collaborator member instead of the service option.
  // ISS-6031, `agent-session-sync-dispositions.ts`:
  "emitDeadLetterTelemetry",
  // ISS-5988 goal stage 2, `agent-session-sync-accepted-ack.ts`:
  "emitTelemetry",
]);
// Membership is tested against ARBITRARY string-literal text pulled out of the
// scanned AST, so the set is keyed by `string` rather than the narrow outcome
// union — the question is "is this source literal one of the outcome values?".
const rawOutcomeValues: ReadonlySet<string> = new Set<string>(
  Object.values(DesktopSyncBatchOutcome)
);
const minimumExpectedProducerOutcomes = 6;

test("agent-session sync telemetry producers use DesktopSyncBatchOutcome members", () => {
  const checkedOutcomes: number[] = [];
  const violations: string[] = [];

  for (const producerPath of syncProducerPaths) {
    const sourceFile = createSourceFile(
      producerPath,
      readFileSync(producerPath, "utf8"),
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    );
    visit(sourceFile, sourceFile, checkedOutcomes, violations);
  }

  assert.ok(
    checkedOutcomes.length >= minimumExpectedProducerOutcomes,
    `expected at least ${minimumExpectedProducerOutcomes} producer outcome expressions across ${syncProducerPaths.length} module(s), checked ${checkedOutcomes.length}`
  );
  assert.deepEqual(violations, []);
});

test("agent-session sync service tests use DesktopSyncBatchOutcome members", () => {
  const sourceFile = createSourceFile(
    syncServiceTestPath,
    readFileSync(syncServiceTestPath, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  const violations: string[] = [];

  collectRawTestOutcomeLiterals(sourceFile, sourceFile, violations);

  assert.deepEqual(violations, []);
});

function visit(
  node: Node,
  sourceFile: SourceFile,
  checkedOutcomes: number[],
  violations: string[]
) {
  if (isCallExpression(node) && isProducerCallbackCall(node)) {
    const outcome = findOutcomeExpression(node.arguments[0]);
    if (outcome) {
      checkedOutcomes.push(outcome.getStart(sourceFile));
      collectRawOutcomeLiterals(outcome, sourceFile, violations);
    }
  }

  forEachChild(node, (child) =>
    visit(child, sourceFile, checkedOutcomes, violations)
  );
}

function isProducerCallbackCall(node: CallExpression) {
  const expression = node.expression;
  return (
    isPropertyAccessExpression(expression) &&
    producerCallbackNames.has(expression.name.text)
  );
}

function findOutcomeExpression(argument: Node | undefined) {
  if (!(argument && isObjectLiteralExpression(argument))) {
    return null;
  }

  for (const property of argument.properties) {
    if (isPropertyAssignment(property) && isOutcomeProperty(property.name)) {
      return property.initializer;
    }
  }

  return null;
}

function isOutcomeProperty(name: PropertyName) {
  return isIdentifier(name) && name.text === "outcome";
}

function collectRawOutcomeLiterals(
  node: Node,
  sourceFile: SourceFile,
  violations: string[]
) {
  if (isStringLiteral(node) && rawOutcomeValues.has(node.text)) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    violations.push(
      `${path.relative(desktopRoot, sourceFile.fileName)}:${line + 1}:${
        character + 1
      } uses raw sync outcome literal "${node.text}"`
    );
  }

  forEachChild(node, (child) =>
    collectRawOutcomeLiterals(child, sourceFile, violations)
  );
}

function collectRawTestOutcomeLiterals(
  node: Node,
  sourceFile: SourceFile,
  violations: string[]
) {
  if (
    isStringLiteral(node) &&
    rawOutcomeValues.has(node.text) &&
    !isAllowedTestLiteral(node)
  ) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    violations.push(
      `${path.relative(desktopRoot, sourceFile.fileName)}:${line + 1}:${
        character + 1
      } uses raw sync outcome literal "${node.text}"`
    );
  }

  forEachChild(node, (child) =>
    collectRawTestOutcomeLiterals(child, sourceFile, violations)
  );
}

function isAllowedTestLiteral(node: Node) {
  const parent = node.parent;
  return (
    isImportDeclaration(parent) ||
    (isCallExpression(parent) &&
      parent.expression.getText() === "test" &&
      parent.arguments[0] === node)
  );
}
