/**
 * @file batch-harness-materialize-wiring.test.ts
 * @description ISS-8600 — every `batch: true` collector must be NAMED by the
 * materialize import-health wiring.
 *
 * `materialize_failed` / `materialize_timed_out` each carry one `harness.name`,
 * and `desktop-transcript-sync-factory.ts` is the layer that supplies it: the
 * discovery sweep that catches the rejection calls `materialize()` without
 * knowing whose store it regenerates, so nothing below the factory can name the
 * harness without guessing. That arrangement is correct only while OpenCode is
 * the sole batch-materialized collector. A second one arrives with its own
 * materialize runner, and until its wiring names itself its failures ship under
 * the existing label — an operator sent to the wrong tool by a monitoring
 * record, with nothing failing `tsc` and every behavioural suite green.
 *
 * BOTH sides are DERIVED. The batch set is read off the real collector roster,
 * which is the file a new collector actually edits; the named set is read off
 * the factory's resolved AST (the sanctioned alternative to a raw text scan —
 * `scripts/lint/rules/no-raw-text-source-scan.ts`). A guard that spelled
 * `"opencode"` itself would be the same assumption one level up, and would go
 * green on exactly the day it is supposed to fail.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import ts from "typescript6";
import { test } from "vitest";
import { defaultCollectors } from "../src/main/collectors/engine/default-collectors.js";
import {
  forEachNode,
  parseTypeScriptFile,
  propertyInitializer,
} from "./helpers/ts-ast.js";

const TRANSCRIPT_SYNC_FACTORY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "main",
  "transcript-sync",
  "desktop-transcript-sync-factory.ts"
);

/** The option the sweep's materialize-outcome sink is wired onto. */
const MATERIALIZE_SINK = "noteMaterializeOutcome";
/** The contract const a record's `harness.name` must be named through. */
const HARNESS_CONST = "TelemetryHarnessName";

/** Contract member name → wire value, so the AST's `X` resolves to its string. */
const HARNESS_VALUE_BY_MEMBER: Readonly<Record<string, string>> =
  TelemetryHarnessName;

test("ISS-8600: the materialize wiring names every batch-materialized collector", () => {
  const batchHarnesses = batchCollectorHarnesses();

  // Both sides are derived, so an empty roster would agree with an empty wiring
  // and report a passing guard over nothing at all.
  assert.ok(
    batchHarnesses.length > 0,
    "the real collector roster must still declare a batch: true collector"
  );

  const wiring = materializeWiringHarnesses();
  assert.equal(
    wiring.wired,
    true,
    `the transcript lane must wire ${MATERIALIZE_SINK}`
  );
  assert.deepEqual(
    wiring.unknownMembers,
    [],
    `${HARNESS_CONST} members the telemetry contract does not declare cannot reach a record's harness.name`
  );
  assert.deepEqual(
    wiring.harnesses,
    batchHarnesses,
    `${MATERIALIZE_SINK} in desktop-transcript-sync-factory.ts must name every batch: true collector's harness — a new batch collector brings its own materialize runner and has to label its own records`
  );
});

/** The `batch: true` harness keys of the REAL production collector roster. */
function batchCollectorHarnesses(): string[] {
  const roster = defaultCollectors(
    // Never read: this constructs the roster to inspect its discriminants and
    // runs no pass, and no collector touches its state dir at construction.
    { stateDir: path.join(tmpdir(), "iss-8600-batch-harness-guard") },
    () => undefined
  );
  return roster
    .filter((collector) => collector.batch === true)
    .map((collector) => collector.key)
    .sort();
}

/**
 * What the factory's materialize sink names, read off the resolved AST.
 *
 * Every finding is RETURNED rather than asserted here, so the whole verdict is
 * pinned by the test body: a helper that threw on the way would report "the
 * sink is missing" and never reach the set comparison that is the actual
 * invariant.
 */
function materializeWiringHarnesses(): MaterializeWiringHarnesses {
  const source = parseTypeScriptFile(TRANSCRIPT_SYNC_FACTORY_PATH);
  const sink = propertyInitializer(source, MATERIALIZE_SINK);
  if (!sink) {
    return { wired: false, harnesses: [], unknownMembers: [] };
  }

  const harnesses = new Set<string>();
  const unknownMembers = new Set<string>();
  forEachNode(sink, (node) => {
    if (
      !(
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === HARNESS_CONST
      )
    ) {
      return;
    }
    const value = HARNESS_VALUE_BY_MEMBER[node.name.text];
    if (value) {
      harnesses.add(value);
      return;
    }
    unknownMembers.add(node.name.text);
  });
  return {
    wired: true,
    harnesses: [...harnesses].sort(),
    unknownMembers: [...unknownMembers].sort(),
  };
}

/** The materialize wiring's verdict — see {@link materializeWiringHarnesses}. */
type MaterializeWiringHarnesses = {
  /** Whether the factory wires the sink at all. */
  readonly wired: boolean;
  /** Contract harness VALUES the wiring names, sorted. */
  readonly harnesses: string[];
  /** `TelemetryHarnessName.X` members the contract does not declare. */
  readonly unknownMembers: string[];
};
