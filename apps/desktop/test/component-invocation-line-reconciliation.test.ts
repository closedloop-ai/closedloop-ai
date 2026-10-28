/**
 * @file component-invocation-line-reconciliation.test.ts
 * @description ISS-10730 (#7718 review): `reportInvocationLineReconciliation`
 * shipped with no direct coverage, which is why it could count one call twice.
 *
 * An id-less mutating call still PRODUCES a candidate — the row writer falls
 * back to a synthetic external id and `invocationLineColumns` gates on kind and
 * validity, never on the id — so that call is already a null-id contribution
 * that `reconcileAttributedInvocationLines` counts unjoinable. Re-scanning
 * `session.toolUses` for every id-less delta counted it a SECOND time and
 * reported its lines as unclaimed residual while the row holding them sat in
 * `agent_component_invocations`. Only a delta the candidate genuinely REFUSED
 * (an invalid count) still needs the synthetic member.
 *
 * ISS-11084 adds the sibling `storedDiffDelta` coverage this module also
 * shipped without, pinning the one spelling the fold reads.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  reportInvocationLineReconciliation,
  storedDiffDelta,
} from "../src/main/database/component-invocation-line-reconciliation.js";
import type { AgentComponentInvocationCandidate } from "../src/main/database/component-invocation-row-writer.js";

function candidate(
  providerToolUseId: string | null,
  linesAdded: number | null,
  linesRemoved: number | null
): AgentComponentInvocationCandidate {
  return {
    providerToolUseId,
    linesAdded,
    linesRemoved,
  } as unknown as AgentComponentInvocationCandidate;
}

function session(
  toolUses: {
    diffDelta?: { add: number; del: number } | null;
    providerToolUseId?: string;
    id?: string;
  }[]
): NormalizedSession {
  return {
    sessionId: "session-1",
    toolUses,
    diffStats: { linesAdded: 100, linesRemoved: 50 },
  } as unknown as NormalizedSession;
}

function capture(
  s: NormalizedSession,
  candidates: AgentComponentInvocationCandidate[]
): string {
  const lines: string[] = [];
  reportInvocationLineReconciliation(s, candidates, (m) => lines.push(m));
  if (lines.length !== 1) {
    throw new Error(
      `expected exactly one reconciliation line, got ${lines.length}`
    );
  }
  return lines[0] as string;
}

const ONE_UNJOINABLE = /1 unjoinable mutating call\(s\)/;
const ZERO_UNJOINABLE = /0 unjoinable mutating call\(s\)/;
const ATTRIBUTED_TEN_TWO = /attributed \+10\/-2 across 1 invocation\(s\)/;
const RESIDUAL_UNKNOWN = /residual unknown \(session reported no diffStats\)/;

describe("reportInvocationLineReconciliation", () => {
  it("counts an id-less mutating call ONCE, not once per scan", () => {
    // One call, no harness id, with a VALID delta: the candidate accepted it,
    // so it is already a null-id contribution and must not be re-counted.
    const line = capture(session([{ diffDelta: { add: 7, del: 3 } }]), [
      candidate(null, 7, 3),
    ]);
    assert.match(line, ONE_UNJOINABLE);
  });

  it("still counts a call whose delta the candidate REFUSED", () => {
    // A fractional count is not storable, so `invocationLineColumns` refused it
    // and no contribution carries it — the synthetic member is what keeps it
    // from being dropped entirely.
    const line = capture(session([{ diffDelta: { add: 1.5, del: 0 } }]), [
      candidate(null, null, null),
    ]);
    assert.match(line, ONE_UNJOINABLE);
  });

  it("attributes a joinable call rather than counting it unjoinable", () => {
    const line = capture(
      session([
        { diffDelta: { add: 10, del: 2 }, providerToolUseId: "toolu_a" },
      ]),
      [candidate("toolu_a", 10, 2)]
    );
    assert.match(line, ATTRIBUTED_TEN_TWO);
    assert.match(line, ZERO_UNJOINABLE);
  });

  it("reports the residual as unknown when the session has no diffStats", () => {
    const s = {
      sessionId: "session-1",
      toolUses: [
        { diffDelta: { add: 4, del: 1 }, providerToolUseId: "toolu_a" },
      ],
      diffStats: null,
    } as unknown as NormalizedSession;
    assert.match(capture(s, [candidate("toolu_a", 4, 1)]), RESIDUAL_UNKNOWN);
  });
});

describe("storedDiffDelta", () => {
  it("folds the flat data.diffDelta a writer produces", () => {
    assert.deepEqual(storedDiffDelta({ diffDelta: { add: 7, del: 2 } }), {
      add: 7,
      del: 2,
    });
  });

  // ISS-11084: `events.data` is a persisted row, so a nested shape is reachable
  // at runtime even though no build has ever written one. The retired
  // `tool_input.diffDelta` arm must not come back by any route.
  it("ignores a delta that sits only under tool_input", () => {
    assert.equal(
      storedDiffDelta({ tool_input: { diffDelta: { add: 7, del: 2 } } }),
      undefined
    );
  });

  it("returns undefined when the row records no delta at all", () => {
    assert.equal(storedDiffDelta({}), undefined);
    assert.equal(storedDiffDelta(null), undefined);
  });

  it("refuses a delta whose halves are not both numbers", () => {
    assert.equal(
      storedDiffDelta({ diffDelta: { add: 7, del: "2" } }),
      undefined
    );
  });
});
