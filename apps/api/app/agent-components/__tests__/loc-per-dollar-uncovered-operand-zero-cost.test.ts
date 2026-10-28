/**
 * @file loc-per-dollar-uncovered-operand-zero-cost.test.ts
 * @description ISS-10730 (whitlockk, #7718 review): a MEASURED $0 is a known
 * figure, so `locPerDollarUncoveredOperand` must NOT name `cost` uncovered for
 * it — that would tell the reader we could not price work we know was free.
 *
 * The distinction under test is null-versus-zero, not zero-versus-positive:
 * `costMeasured: false` is genuinely unknown and DOES name `cost`, while
 * `costMeasured: true` at exactly $0 is an undefined ratio and names nothing.
 * Collapsing a measured 0 to null before the resolver sees it makes those two
 * cases indistinguishable, which is the defect these cases pin.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { InvocationLocPerDollarUncoveredOperand } from "@repo/api/src/types/agent-component-invocation-lines";
import { LOC_SOURCE_GIT } from "@repo/api/src/utils/session-loc";
import { describe, expect, it } from "vitest";
import {
  locPerDollarUncoveredOperand,
  type SessionLocCost,
} from "../loc-per-dollar";

const SESSION = "session-zero-cost";

function locCost(
  loc: number,
  cost: number,
  costMeasured: boolean
): SessionLocCost {
  return {
    branch: null,
    cost,
    costMeasured,
    loc,
    locSource: LOC_SOURCE_GIT,
    repositoryFullName: null,
    // Irrelevant to the uncovered-operand resolution under test; `null` rather
    // than `0` so the fixture claims no measurement it did not take.
    tokens: null,
  };
}

describe("locPerDollarUncoveredOperand — measured zero cost", () => {
  it("names nothing when a verifiable kind's spend was MEASURED at exactly $0", () => {
    expect(
      locPerDollarUncoveredOperand(
        AgentComponentKind.Subagent,
        [SESSION],
        new Map([[SESSION, locCost(120, 0, true)]])
      )
    ).toBeUndefined();
  });

  it("names cost when the spend was never measured at all", () => {
    expect(
      locPerDollarUncoveredOperand(
        AgentComponentKind.Subagent,
        [SESSION],
        new Map([[SESSION, locCost(120, 0, false)]])
      )
    ).toBe(InvocationLocPerDollarUncoveredOperand.Cost);
  });

  it("still names lines when the measured $0 session produced none", () => {
    expect(
      locPerDollarUncoveredOperand(
        AgentComponentKind.Subagent,
        [SESSION],
        new Map([[SESSION, locCost(0, 0, true)]])
      )
    ).toBe(InvocationLocPerDollarUncoveredOperand.Lines);
  });
});
