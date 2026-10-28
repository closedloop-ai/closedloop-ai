/**
 * ISS-7352 (whitlockk review) — Claude OTel capture must honor BOTH switches.
 *
 * The gate originally read only `claudeCodeOtelCapture`, so a user who turned
 * Claude collection off in the collector UI would still have OTel rows written
 * underneath them: the UI would be promising a state the store contradicted.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { test } from "vitest";
import { claudeCaptureGate } from "../src/main/telemetry/otlp-receiver-wiring.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const DESKTOP_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const COMPOSITION_ROOT_SOURCE =
  "src/main/dashboard/agent-dashboard-design-system-runtime.ts";
const GATE_HELPER = "claudeCaptureGate";
/**
 * The production reader each gate argument must actually consult. Naming them
 * here is the point of the guard: a gate built from the right helper but handed
 * a constant reads no setting at all.
 */
const REQUIRED_GATE_READERS = {
  isOtelCaptureEnabled: "isClaudeCodeOtelCaptureEnabled",
  isClaudeCollectorEnabled: "currentCollectorEnabledState",
} as const;

test("ISS-7352: capture requires the OTel toggle AND the Claude collector", () => {
  const cases = [
    { otel: true, collector: true, allowed: true },
    { otel: true, collector: false, allowed: false },
    { otel: false, collector: true, allowed: false },
    { otel: false, collector: false, allowed: false },
  ];

  for (const { otel, collector, allowed } of cases) {
    const gate = claudeCaptureGate({
      isOtelCaptureEnabled: () => otel,
      isClaudeCollectorEnabled: () => collector,
    });
    assert.equal(
      gate(),
      allowed,
      `otel=${otel} collector=${collector} should be ${allowed}`
    );
  }
});

test("ISS-7352: both switches are re-read on every export", () => {
  // Captured-at-construction would keep capturing until the next app start,
  // which is the opposite of what flipping a privacy switch must mean.
  let otel = true;
  let collector = true;
  const gate = claudeCaptureGate({
    isOtelCaptureEnabled: () => otel,
    isClaudeCollectorEnabled: () => collector,
  });

  assert.equal(gate(), true);
  collector = false;
  assert.equal(gate(), false, "turning the collector off takes effect at once");
  collector = true;
  otel = false;
  assert.equal(gate(), false, "turning OTel capture off takes effect at once");
  otel = true;
  assert.equal(gate(), true, "and turning both back on resumes capture");
});

// The behavioral tests above prove the helper, and stay green if the
// composition root stops calling it. They also stay green if it calls it with
// the WRONG THING: they inject their own readers, so none of them reaches the
// production one. Pinning only the callee was the same hole one level up —
// `isOtelCaptureEnabled: () => true` ships capture on for every install,
// ignoring `claudeCodeOtelCapture`, and left all four suites here green. So the
// ARGUMENT is what this pins. AST, not a text scan: `no-raw-text-source-scan`
// bans asserting on source as raw text.
test("ISS-7352: the composition root's capture gate reads the real switches", () => {
  const root = parseTypeScriptFile(
    path.join(DESKTOP_ROOT, COMPOSITION_ROOT_SOURCE)
  );
  const gate = captureGateCall(root);

  assert.equal(
    gate?.callee,
    GATE_HELPER,
    `isClaudeCaptureEnabled must be built by ${GATE_HELPER}(...) in ${COMPOSITION_ROOT_SOURCE}; reading one switch inline lets OTel rows write while the collector UI says Claude collection is off`
  );
  for (const [reader, required] of Object.entries(REQUIRED_GATE_READERS)) {
    const shape = gate?.readers.get(reader);
    assert.ok(shape, `${GATE_HELPER} must be passed a ${reader} reader`);
    assert.ok(
      shape.names.has(required),
      `${reader} must read ${required}; anything else captures Claude Code telemetry on a setting the user never turned on (ISS-4779 closed-by-default)`
    );
    assert.equal(
      shape.usesTrueLiteral,
      false,
      `${reader} must not fall back to \`true\` — an absent reader means the switch is OFF, not on`
    );
  }
});

/** What each reader passed to the gate looks like, and the gate's callee. */
type CaptureGateCall = {
  callee: string;
  readers: Map<string, GateReaderShape>;
};

type GateReaderShape = {
  /** Every identifier the reader's body mentions — its production source. */
  names: Set<string>;
  /** Whether the body hardcodes `true`, directly or as a `??` fallback. */
  usesTrueLiteral: boolean;
};

/** The `isClaudeCaptureEnabled:` property's call initializer, or null. */
function captureGateCall(source: ts.SourceFile): CaptureGateCall | null {
  let call: CaptureGateCall | null = null;
  forEachNode(source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "isClaudeCaptureEnabled" &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression)
    ) {
      call = {
        callee: node.initializer.expression.text,
        readers: gateReadersOf(node.initializer.arguments),
      };
    }
  });
  return call;
}

function gateReadersOf(
  args: ts.NodeArray<ts.Expression>
): Map<string, GateReaderShape> {
  const readers = new Map<string, GateReaderShape>();
  for (const argument of args) {
    if (!ts.isObjectLiteralExpression(argument)) {
      continue;
    }
    for (const property of argument.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        readers.set(property.name.text, readerShapeOf(property.initializer));
      }
    }
  }
  return readers;
}

function readerShapeOf(initializer: ts.Expression): GateReaderShape {
  const names = new Set<string>();
  let usesTrueLiteral = false;
  forEachNode(initializer, (node) => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      usesTrueLiteral = true;
    }
  });
  return { names, usesTrueLiteral };
}
