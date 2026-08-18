/**
 * @file sanitize-subagent-id-segment.test.ts
 * @description ISS-5099 review: `sanitizeSubagentIdSegment` is the ONE shared
 * sanitizer both agent-id minting lanes use — write-core's `agents`-row ids and
 * component-invocations' `parserAgentId` — so its contract (character class +
 * 160-char slice) is load-bearing for the invocation `agent_id` FK. This pins
 * that contract; the two lanes import the same symbol from
 * `import-metadata-builders.ts`, so they cannot drift from each other.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sanitizeSubagentIdSegment } from "../src/main/database/import-metadata-builders.js";

describe("sanitizeSubagentIdSegment", () => {
  test("keeps [A-Za-z0-9_.:-] and replaces everything else with _", () => {
    assert.equal(
      sanitizeSubagentIdSegment("workflows__abc__agent-1.2:x"),
      "workflows__abc__agent-1.2:x"
    );
    assert.equal(sanitizeSubagentIdSegment("agent child"), "agent_child");
    assert.equal(sanitizeSubagentIdSegment("agent+child"), "agent_child");
    assert.equal(sanitizeSubagentIdSegment("a/b\\c#d"), "a_b_c_d");
  });

  test("slices to 160 characters", () => {
    const long = "x".repeat(200);
    const sanitized = sanitizeSubagentIdSegment(long);
    assert.equal(sanitized.length, 160);
    assert.equal(sanitized, "x".repeat(160));
  });

  test("an id with no allowed characters collapses to underscores, not empty", () => {
    assert.equal(sanitizeSubagentIdSegment("!!"), "__");
    assert.equal(sanitizeSubagentIdSegment(""), "");
  });
});
