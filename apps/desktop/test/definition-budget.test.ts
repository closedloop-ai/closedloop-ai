/**
 * @file definition-budget.test.ts
 * @description ISS-5274 — the definition payload's wire budget, tested against
 * the PURE exported helper the worker actually calls.
 *
 * Deliberately not tested through `pack-scan-runner.test.ts`'s fake child: that
 * child only records the messages handed to it, so it could prove a message was
 * sent but never that the real worker OMITS rather than TRUNCATES. The
 * distinction is the whole invariant — a truncated payload would be applied as
 * complete and every definition it dropped reconciled to `missing`, which is
 * exactly the silent omission this ticket forbids.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "@repo/api/src/types/agent-component";
import {
  type DefinitionWire,
  definitionBudgetOmissionReason,
  MAX_DEFINITION_CONTENT_BYTES,
  MAX_DEFINITIONS,
} from "../src/main/packs/pack-scan-worker-protocol.js";

const COUNT_REASON = /count/;
const BYTES_REASON = /bytes/;

function wireDefinition(index: number, content = "body"): DefinitionWire {
  return {
    primary: {
      kind: "skill",
      externalId: `skill-${index}`,
      name: `skill-${index}`,
      installPath: `/tmp/skill-${index}/SKILL.md`,
      content,
      harness: Harness.Claude,
    },
    variants: [],
  };
}

test("a payload at the count limit is within budget", () => {
  const definitions = Array.from({ length: MAX_DEFINITIONS }, (_v, i) =>
    wireDefinition(i)
  );
  assert.equal(definitionBudgetOmissionReason(definitions), null);
});

test("a payload one over the count limit is omitted, never truncated", () => {
  const definitions = Array.from({ length: MAX_DEFINITIONS + 1 }, (_v, i) =>
    wireDefinition(i)
  );
  const reason = definitionBudgetOmissionReason(definitions);
  assert.ok(reason, "over-count must produce an omission reason");
  assert.match(reason, COUNT_REASON);
  // The helper's contract is a verdict, not a smaller list: it has no way to
  // return a partial payload, which is what keeps "presence ⇒ complete" true.
  assert.equal(definitions.length, MAX_DEFINITIONS + 1);
});

test("a payload over the byte limit is omitted", () => {
  // One definition whose body alone blows the byte budget.
  const huge = "x".repeat(MAX_DEFINITION_CONTENT_BYTES + 1);
  const reason = definitionBudgetOmissionReason([wireDefinition(0, huge)]);
  assert.ok(reason, "over-bytes must produce an omission reason");
  assert.match(reason, BYTES_REASON);
});

test("variant bodies count toward the byte budget", () => {
  const half = "x".repeat(Math.ceil(MAX_DEFINITION_CONTENT_BYTES / 2) + 1);
  const definition = wireDefinition(0, half);
  definition.variants = [wireDefinition(1, half).primary];
  assert.ok(
    definitionBudgetOmissionReason([definition]),
    "retained variant bodies cross the wire too and must be measured"
  );
});

test("byte counting is by UTF-8 length, not JS string length", () => {
  // A 4-byte astral character repeated to just over the limit: counting
  // `.length` would under-measure it by half and let an oversized payload past.
  const astral = "\u{1F600}".repeat(MAX_DEFINITION_CONTENT_BYTES / 4 + 1);
  assert.ok(astral.length < MAX_DEFINITION_CONTENT_BYTES);
  assert.ok(definitionBudgetOmissionReason([wireDefinition(0, astral)]));
});

test("an empty payload is within budget", () => {
  assert.equal(definitionBudgetOmissionReason([]), null);
});
