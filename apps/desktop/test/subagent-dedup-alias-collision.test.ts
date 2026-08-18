/**
 * @file subagent-dedup-alias-collision.test.ts
 * @description ISS-5105 review guard: the delegation alias index must refuse to
 * resolve an id that two DIFFERENT tool uses answer to.
 *
 * `indexDelegationToolUses` registers each delegating tool use under BOTH its
 * transcript `id` and its `providerToolUseId`, so one id can be tool A's
 * provider id and tool B's transcript id. Both fields cross the same
 * parser/sidecar trust boundary, so that shape is corrupt-but-reachable input.
 * Last-write-wins let it resolve to whichever tool was indexed LAST: a sidecar
 * claim on the shared id canonicalized to A's claim key or to B's purely by read
 * order, so the same evidence re-read moved the attribution. These tests build
 * the index over both orders and assert the outcome is identical AND unresolved.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  NormalizedSubagent,
  NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { buildSubagentDedupIndex } from "../src/main/database/subagent-dedup.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "aliascollide";
/** Tool A's transcript id. */
const A_ID = "toolu_alias_x";
/** Tool A's provider id AND tool B's transcript id — the collided key. */
const SHARED_ID = "toolu_alias_y";
/** Tool B's provider id. */
const B_PROVIDER_ID = "toolu_alias_z";
const CHILD = "agent-aliasclaimant";
const PARSER_AGENT_ID = `${SESSION_ID}-parser-sub-${CHILD}`;

function delegation(
  id: string,
  providerToolUseId: string,
  timestamp: string
): NormalizedToolUse {
  return {
    name: "Agent",
    timestamp,
    id,
    providerToolUseId,
    input: { prompt: "work", subagent_type: "general-purpose" },
    resultTimestamp: "2026-06-07T10:00:40.000Z",
  };
}

function claimant(): NormalizedSubagent {
  return {
    id: CHILD,
    name: "sidecar claiming the shared id",
    type: "general-purpose",
    task: "work",
    startedAt: "2026-06-07T10:00:30.000Z",
    endedAt: "2026-06-07T10:00:40.000Z",
    metadata: { spawnedByToolUseId: SHARED_ID },
  };
}

function indexOver(toolUses: readonly NormalizedToolUse[]): {
  claimKeys: [string, string][];
  resolvedSpawnToolUseIds: (string | undefined)[];
} {
  const subagents = [claimant()];
  const index = buildSubagentDedupIndex(
    makePopulatedSession({
      sessionId: SESSION_ID,
      subagents,
      toolUses: [...toolUses],
    }),
    subagents,
    new Map([[CHILD, PARSER_AGENT_ID]])
  );
  return {
    claimKeys: [...index.parserAgentIdBySpawnToolUseId.entries()].sort(),
    resolvedSpawnToolUseIds: subagents.map(
      (subagent) => index.spawnToolUseBySubagentId.get(subagent.id)?.id
    ),
  };
}

describe("buildSubagentDedupIndex when one id aliases two delegations", () => {
  test("the collided id resolves to neither tool use, so the claim stays raw", () => {
    const forward = indexOver([
      delegation(A_ID, SHARED_ID, "2026-06-07T10:00:10.000Z"),
      delegation(SHARED_ID, B_PROVIDER_ID, "2026-06-07T10:00:20.000Z"),
    ]);

    // Neither A's canonical key (SHARED_ID via its provider field) nor B's
    // (B_PROVIDER_ID) is adopted: the claim keeps its own raw spelling, which is
    // what an unresolvable claim has always done.
    assert.deepEqual(forward.claimKeys, [[SHARED_ID, PARSER_AGENT_ID]]);
    assert.deepEqual(forward.resolvedSpawnToolUseIds, [undefined]);
  });

  test("reversing the index order does not change the outcome", () => {
    const forward = indexOver([
      delegation(A_ID, SHARED_ID, "2026-06-07T10:00:10.000Z"),
      delegation(SHARED_ID, B_PROVIDER_ID, "2026-06-07T10:00:20.000Z"),
    ]);
    const reversed = indexOver([
      delegation(SHARED_ID, B_PROVIDER_ID, "2026-06-07T10:00:20.000Z"),
      delegation(A_ID, SHARED_ID, "2026-06-07T10:00:10.000Z"),
    ]);

    assert.deepEqual(reversed, forward);
  });

  test("a tool use reachable twice is a duplicate, not a collision", () => {
    // The same delegation can reach the index from `session.toolUses` and from
    // a parent subagent's `toolUses`. Dropping the key there would break the
    // nested-delegation span repair the index exists to feed.
    const duplicated = delegation(A_ID, SHARED_ID, "2026-06-07T10:00:10.000Z");
    const subagents = [
      {
        ...claimant(),
        metadata: { spawnedByToolUseId: A_ID },
        toolUses: [{ ...duplicated }],
      },
    ];
    const index = buildSubagentDedupIndex(
      makePopulatedSession({
        sessionId: SESSION_ID,
        subagents,
        toolUses: [duplicated],
      }),
      subagents,
      new Map([[CHILD, PARSER_AGENT_ID]])
    );

    // The claim canonicalizes onto the tool use's provider id, proving the key
    // survived both registrations.
    assert.deepEqual(
      [...index.parserAgentIdBySpawnToolUseId.entries()],
      [[SHARED_ID, PARSER_AGENT_ID]]
    );
    assert.equal(index.spawnToolUseBySubagentId.get(CHILD)?.id, A_ID);
  });
});
