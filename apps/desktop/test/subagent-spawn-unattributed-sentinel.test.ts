/**
 * @file subagent-spawn-unattributed-sentinel.test.ts
 * @description The unattributed provenance anchor must never be paired with a
 * delegating tool call.
 *
 * `UNATTRIBUTED_SUBAGENT_ID` exists so a token record from a sidechain turn that
 * identifies no agent still resolves to a listed subagent instead of being
 * counted as the parent's. Nothing spawned it and nobody chose it, so it is not
 * a delegation.
 *
 * The invocation lane already refused to emit a candidate FOR it. That is one
 * step too late: the spawn matcher runs first over the same roster, and its last
 * fallback tier pairs on `startedAt === toolUse.timestamp`. The anchor carries
 * the timestamp of the sidechain record that minted it, so a delegation in the
 * same instant claimed it — and the claim also consumed a slot in
 * `representedSubagentIds`, which could hide a REAL subagent behind the anchor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNATTRIBUTED_SUBAGENT_ID } from "@repo/lib/harness/claude/parse-claude-subagents";
import type {
  NormalizedSession,
  NormalizedSubagent,
} from "@repo/lib/harness/types";
import { pairDelegationsWithSubagents } from "../src/main/database/subagent-spawn-matching.js";

const TS = "2026-07-09T12:00:01.000Z";

function subagent(
  id: string,
  overrides: Partial<NormalizedSubagent> = {}
): NormalizedSubagent {
  return {
    id,
    parentId: null,
    name: id,
    startedAt: TS,
    endedAt: null,
    status: "completed",
    nativeSubagentId: id,
    toolUses: [],
    ...overrides,
  } as NormalizedSubagent;
}

function sessionWith(subagents: NormalizedSubagent[]): NormalizedSession {
  return {
    subagents,
    toolUses: [
      {
        name: "Agent",
        kind: "harness",
        timestamp: TS,
        input: { subagent_type: "general-purpose" },
        subagentId: null,
      },
    ],
  } as unknown as NormalizedSession;
}

test("a delegation never claims the unattributed provenance anchor", () => {
  const session = sessionWith([
    subagent(UNATTRIBUTED_SUBAGENT_ID, { type: "general-purpose" }),
  ]);

  const { pairs, representedSubagentIds } = pairDelegationsWithSubagents(
    session,
    new Map()
  );

  assert.equal(
    pairs[0]?.parserSubagent,
    null,
    "the anchor shares the delegation's timestamp and type, and must still not be paired"
  );
  assert.equal(
    representedSubagentIds.has(UNATTRIBUTED_SUBAGENT_ID),
    false,
    "the anchor must not consume a represented slot either"
  );
});

test("a real subagent is still paired when the anchor is present", () => {
  // The control that makes the case above meaningful twice over: the anchor must
  // not be matched, AND it must not stand in front of the row that should be.
  // Ordered anchor-first on purpose — that is the arrangement in which a
  // first-match-wins scan would take the wrong one.
  const session = sessionWith([
    subagent(UNATTRIBUTED_SUBAGENT_ID, { type: "general-purpose" }),
    subagent("agent-real", { type: "general-purpose" }),
  ]);

  const { pairs, representedSubagentIds } = pairDelegationsWithSubagents(
    session,
    new Map()
  );

  assert.equal(pairs[0]?.parserSubagent?.id, "agent-real");
  assert.equal(representedSubagentIds.has("agent-real"), true);
  assert.equal(representedSubagentIds.has(UNATTRIBUTED_SUBAGENT_ID), false);
});

test("an ordinary roster with no anchor is unaffected", () => {
  const session = sessionWith([
    subagent("agent-only", { type: "general-purpose" }),
  ]);

  const { pairs } = pairDelegationsWithSubagents(session, new Map());

  assert.equal(pairs[0]?.parserSubagent?.id, "agent-only");
});
