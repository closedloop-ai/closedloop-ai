/**
 * FEA-4052 — per-component-type LOC/$ verifiability contract.
 *
 * LOC/$ (cost-efficiency) is only a reliable per-component signal for a kind
 * whose invocation IS the whole unit of work its LOC/cost measures. Only
 * `subagent` qualifies: it authors its own session, so that session's full
 * LOC/cost is genuinely one component's.
 *
 * `skill` and `command` are DELIBERATELY excluded (wongk, PR #3720): a single
 * session can record a skill AND a command independently, yet each usage row is
 * attributed the session's FULL LOC/cost, so both would report session-level
 * efficiency, not their own share. Until a session's LOC/cost can be partitioned
 * across its co-invoked components, they are non-verifiable and must not report a
 * LOC/$ figure. This pins that gate so both the service (nulling
 * `locPerDollar`) and the UI surfaces (hiding the LOC/$ column + card) share it.
 */
import { describe, expect, it } from "vitest";
import {
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
  LOC_PER_DOLLAR_VERIFIABLE_KINDS,
} from "./agent-component";

describe("isLocPerDollarVerifiableKind (FEA-4052)", () => {
  const VERIFIABLE: AgentComponentKind[] = [AgentComponentKind.Subagent];

  // Skill and Command are excluded until session partitioning exists — a session
  // gives every co-invoked component its FULL LOC/cost, so their per-component
  // LOC/$ would be a misleading session-level number (wongk, PR #3720).
  const NON_VERIFIABLE: AgentComponentKind[] = [
    AgentComponentKind.Skill,
    AgentComponentKind.Command,
    AgentComponentKind.Plugin,
    AgentComponentKind.Mcp,
    AgentComponentKind.Tool,
    AgentComponentKind.Orchestration,
    AgentComponentKind.Workflow,
    AgentComponentKind.Hook,
    AgentComponentKind.Config,
  ];

  it.each(VERIFIABLE)("treats %s as verifiable", (kind) => {
    expect(isLocPerDollarVerifiableKind(kind)).toBe(true);
    expect(LOC_PER_DOLLAR_VERIFIABLE_KINDS.has(kind)).toBe(true);
  });

  it.each(NON_VERIFIABLE)("treats %s as non-verifiable", (kind) => {
    expect(isLocPerDollarVerifiableKind(kind)).toBe(false);
    expect(LOC_PER_DOLLAR_VERIFIABLE_KINDS.has(kind)).toBe(false);
  });

  it("excludes skill and command from the LOC/$ gate (session-level attribution, wongk PR #3720)", () => {
    expect(isLocPerDollarVerifiableKind(AgentComponentKind.Skill)).toBe(false);
    expect(isLocPerDollarVerifiableKind(AgentComponentKind.Command)).toBe(
      false
    );
    expect(LOC_PER_DOLLAR_VERIFIABLE_KINDS.has(AgentComponentKind.Skill)).toBe(
      false
    );
    expect(
      LOC_PER_DOLLAR_VERIFIABLE_KINDS.has(AgentComponentKind.Command)
    ).toBe(false);
  });

  it("verifiable set is exactly {subagent}", () => {
    expect([...LOC_PER_DOLLAR_VERIFIABLE_KINDS]).toEqual([
      AgentComponentKind.Subagent,
    ]);
  });

  it("covers every AgentComponentKind exactly once across the two buckets", () => {
    const covered = new Set<AgentComponentKind>([
      ...VERIFIABLE,
      ...NON_VERIFIABLE,
    ]);
    const all = Object.values(AgentComponentKind);
    expect(covered.size).toBe(all.length);
    for (const kind of all) {
      expect(covered.has(kind)).toBe(true);
    }
  });
});
