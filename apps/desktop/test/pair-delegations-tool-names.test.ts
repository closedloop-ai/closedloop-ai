/**
 * @file pair-delegations-tool-names.test.ts
 * @description ISS-5099 review guard: `pairDelegationsWithSubagents` must select
 * the delegations it settles from `DELEGATION_TOOL_NAMES` — the SAME set
 * `buildSubagentDedupIndex` indexes on the `agents` write lane.
 *
 * A hand-written `name === "Agent" || name === "Task"` filter in the pre-pass
 * passes today by accident: it happens to spell out the set's current members.
 * The moment a harness adds a third delegation tool name, the dedup index would
 * claim it and the pre-pass would skip it — the invocation lane falls back to
 * the greedy fuzzy tiers and synthesizes a `-sub-<toolUseId>` agent id the write
 * lane never minted, which is exactly the two-lane disagreement this PR closes.
 *
 * The cases below are generated FROM the set, so a name added there without a
 * matching pre-pass change fails here rather than in production.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DELEGATION_TOOL_NAMES } from "../src/main/database/subagent-dedup.js";
import { pairDelegationsWithSubagents } from "../src/main/database/subagent-spawn-matching.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "delegnames";
const TOOL_USE_ID = "toolu_deleg_1";
const CHILD_ID = "agent-child01";
const PARSER_AGENT_ID = `${SESSION_ID}-parser-sub-${CHILD_ID}`;

describe("pairDelegationsWithSubagents selects on DELEGATION_TOOL_NAMES", () => {
  for (const toolName of DELEGATION_TOOL_NAMES) {
    test(`a "${toolName}" delegation is settled from the shared exact claim`, () => {
      const session = makePopulatedSession({
        sessionId: SESSION_ID,
        subagents: [
          {
            id: CHILD_ID,
            name: "delegated work",
            type: "general-purpose",
            task: "delegated work",
            startedAt: "2026-06-07T10:00:30.000Z",
            endedAt: "2026-06-07T10:00:40.000Z",
            metadata: { spawnedByToolUseId: TOOL_USE_ID },
          },
        ],
        toolUses: [
          {
            name: toolName,
            timestamp: "2026-06-07T10:00:30.000Z",
            id: TOOL_USE_ID,
            input: { prompt: "work", subagent_type: "general-purpose" },
            resultTimestamp: "2026-06-07T10:00:40.000Z",
          },
        ],
      });

      const { pairs, representedSubagentIds } = pairDelegationsWithSubagents(
        session,
        new Map([[CHILD_ID, PARSER_AGENT_ID]])
      );

      assert.deepEqual(
        pairs.map((pair) => ({
          index: pair.index,
          name: pair.toolUse.name,
          parserSubagentId: pair.parserSubagent?.id ?? null,
        })),
        [{ index: 0, name: toolName, parserSubagentId: CHILD_ID }]
      );
      assert.deepEqual([...representedSubagentIds], [CHILD_ID]);
    });
  }
});
