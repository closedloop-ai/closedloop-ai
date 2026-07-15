/**
 * @file evidence-timeline.test.ts
 * @description FEA-2269/FEA-2268 tests for `buildEvidenceTimeline`: the ordered,
 * time-anchored evidence stream the classifier windows. Asserts the total
 * ordering by ms, the adapter-routed abstract categorization (harness-blind),
 * declared-layer collection, undateable-signal dropping, and determinism.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidenceTimeline } from "../src/main/collectors/evidence/build-session-evidence.js";
import {
  EvidenceLayer,
  ToolCategory,
} from "../src/main/collectors/evidence/evidence-model.js";
import { Harness } from "../src/main/collectors/types.js";
import { makeSession, toolUse } from "./normalized-session-test-utils.js";

const ms = (iso: string): number => Date.parse(iso);

test("orders units by ms and maps Claude tools to abstract categories", () => {
  const session = makeSession({
    sessionId: "timeline",
    // deliberately out of time order — the builder must sort.
    toolUses: [
      toolUse("Edit", "2026-01-01T00:03:00.000Z"),
      toolUse("Read", "2026-01-01T00:01:00.000Z"),
    ],
    messages: [
      { role: "human", timestamp: "2026-01-01T00:02:00.000Z", text: null },
    ],
    slashCommands: [{ name: "plan", timestamp: "2026-01-01T00:00:30.000Z" }],
  });

  const timeline = buildEvidenceTimeline(session, Harness.Claude);

  assert.deepEqual(
    timeline.map((u) => u.ms),
    [
      ms("2026-01-01T00:00:30.000Z"),
      ms("2026-01-01T00:01:00.000Z"),
      ms("2026-01-01T00:02:00.000Z"),
      ms("2026-01-01T00:03:00.000Z"),
    ],
    "sorted ascending by timestamp"
  );
  assert.deepEqual(
    timeline.map((u) => u.category),
    [
      ToolCategory.DeclaredIntent,
      ToolCategory.ReadSearch,
      ToolCategory.HumanTurn,
      ToolCategory.MutateCode,
    ],
    "slash command → declared; Read → read_search; human msg → human_turn; Edit → mutate_code"
  );
  assert.equal(timeline[0].layer, EvidenceLayer.Declared);
  assert.equal(timeline[1].layer, EvidenceLayer.Structural);
});

test("drops undateable signals and is deterministic", () => {
  const session = makeSession({
    sessionId: "timeline-nulls",
    toolUses: [
      // no timestamp → cannot be placed on the timeline → dropped
      toolUse("Read", null),
      toolUse("Edit", "2026-01-01T00:01:00.000Z"),
    ],
  });

  const first = buildEvidenceTimeline(session, Harness.Claude);
  const second = buildEvidenceTimeline(session, Harness.Claude);

  assert.equal(first.length, 1, "the timestamp-less Read is dropped");
  assert.equal(first[0].category, ToolCategory.MutateCode);
  assert.deepEqual(first, second, "identical input → identical timeline");
});

test("unrecognized tool names contribute no structural unit", () => {
  const session = makeSession({
    sessionId: "timeline-unknown",
    toolUses: [
      // TodoWrite / Task are not structural categories in the Claude adapter.
      toolUse("TodoWrite", "2026-01-01T00:01:00.000Z"),
      toolUse("Read", "2026-01-01T00:02:00.000Z"),
    ],
  });

  const timeline = buildEvidenceTimeline(session, Harness.Claude);
  assert.deepEqual(
    timeline.map((u) => u.category),
    [ToolCategory.ReadSearch],
    "only the recognized Read maps to a category"
  );
});
