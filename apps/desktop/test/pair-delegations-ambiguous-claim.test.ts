/**
 * @file pair-delegations-ambiguous-claim.test.ts
 * @description ISS-5105 review guard: an ambiguously-claimed delegation must
 * pair to NOTHING, and must do so whatever order the sidecars were read in.
 *
 * `buildSubagentDedupIndex` already refuses to retire the `-sub-<toolUseId>`
 * fallback `agents` row when two children claim one delegation, so that row —
 * and the spawn event anchored to it — survives. The invocation lane used to
 * disagree: tier 0 declined to pick between the contesting children, then the
 * type-only tier picked one anyway, by array position. Sidecar files are read
 * off the filesystem, so array position is load order: the same evidence,
 * re-read, moved the invocation to the other child. These tests execute the
 * pairing over both orders and assert the outcome is identical AND null.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  NormalizedSubagent,
  NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { pairDelegationsWithSubagents } from "../src/main/database/subagent-spawn-matching.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "ambigclaim";
const CONTESTED_TOOL_USE_ID = "toolu_contested_1";
const SIBLING_TOOL_USE_ID = "toolu_sibling_1";
const SUBAGENT_TYPE = "adv-ambiguous";
const CLAIMANT_A = "agent-claimant1";
const CLAIMANT_B = "agent-claimant2";

function claimant(id: string): NormalizedSubagent {
  return {
    id,
    name: `Claude subagent ${id}`,
    type: SUBAGENT_TYPE,
    task: "contested work",
    startedAt: "2026-06-07T10:00:30.000Z",
    endedAt: "2026-06-07T10:00:40.000Z",
    metadata: { spawnedByToolUseId: CONTESTED_TOOL_USE_ID },
  };
}

function delegation(id: string): NormalizedToolUse {
  return {
    name: "Agent",
    timestamp: "2026-06-07T10:00:30.000Z",
    id,
    input: { prompt: "work", subagent_type: SUBAGENT_TYPE },
    resultTimestamp: "2026-06-07T10:00:40.000Z",
  };
}

function pairedIdsFor(
  subagents: readonly NormalizedSubagent[],
  toolUseIds: readonly string[]
): { pairedIds: (string | null)[]; representedIds: string[] } {
  const session = makePopulatedSession({
    sessionId: SESSION_ID,
    subagents: [...subagents],
    toolUses: toolUseIds.map(delegation),
  });
  const { pairs, representedSubagentIds } = pairDelegationsWithSubagents(
    session,
    new Map(
      subagents.map((sub) => [sub.id, `${SESSION_ID}-parser-sub-${sub.id}`])
    )
  );
  return {
    pairedIds: pairs.map((pair) => pair.parserSubagent?.id ?? null),
    representedIds: [...representedSubagentIds].sort(),
  };
}

describe("pairDelegationsWithSubagents under an ambiguous spawn claim", () => {
  test("the contested delegation pairs to nothing, so its invocation lands on the fallback row the agents lane kept", () => {
    const { pairedIds, representedIds } = pairedIdsFor(
      [claimant(CLAIMANT_A), claimant(CLAIMANT_B)],
      [CONTESTED_TOOL_USE_ID]
    );

    assert.deepEqual(pairedIds, [null]);
    assert.deepEqual(representedIds, []);
  });

  test("reordering the sidecars does not change attribution", () => {
    const forward = pairedIdsFor(
      [claimant(CLAIMANT_A), claimant(CLAIMANT_B)],
      [CONTESTED_TOOL_USE_ID]
    );
    const reversed = pairedIdsFor(
      [claimant(CLAIMANT_B), claimant(CLAIMANT_A)],
      [CONTESTED_TOOL_USE_ID]
    );

    assert.deepEqual(reversed, forward);
  });

  test("a same-type sibling delegation cannot inherit a contesting child either", () => {
    // Without the exclusion this delegation reaches the type-only tier and
    // takes whichever claimant sorts first — the same load-order roulette one
    // delegation over.
    const forward = pairedIdsFor(
      [claimant(CLAIMANT_A), claimant(CLAIMANT_B)],
      [CONTESTED_TOOL_USE_ID, SIBLING_TOOL_USE_ID]
    );
    const reversed = pairedIdsFor(
      [claimant(CLAIMANT_B), claimant(CLAIMANT_A)],
      [CONTESTED_TOOL_USE_ID, SIBLING_TOOL_USE_ID]
    );

    assert.deepEqual(forward.pairedIds, [null, null]);
    assert.deepEqual(reversed, forward);
  });
});
