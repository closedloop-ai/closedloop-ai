import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_FOOTPRINT_SOURCE,
  AgentComponentFootprintSource,
  agentComponentFootprintFromTokenCount,
  estimateAgentComponentFootprintTokens,
  isValidAgentComponentFootprintTokens,
  resolveAgentComponentFootprint,
} from "../agent-component-footprint.ts";
import {
  AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
  AgentComponentInvocationUsageMeasurement,
} from "../agent-component-invocation.ts";

/**
 * ISS-10736. The declaration under test is what makes "all seven kinds" hold, so
 * the member list below is written out as a NON-CIRCULAR literal rather than
 * derived from the very const it polices. A fixture built from
 * `AgentComponentInvocationKind` would stay green if a kind were deleted from
 * the union, which is precisely the regression this file exists to catch — the
 * duplication IS the test.
 */
const SEVEN_INVOCATION_KINDS = [
  "tool",
  "mcp",
  "orchestration",
  "command",
  "skill",
  "subagent",
  "hook",
] as const;

describe("AGENT_COMPONENT_FOOTPRINT_SOURCE", () => {
  it("declares a source for exactly the seven invocation kinds", () => {
    expect(Object.keys(AGENT_COMPONENT_FOOTPRINT_SOURCE).sort()).toEqual(
      [...SEVEN_INVOCATION_KINDS].sort()
    );
  });

  it("names the source ISS-10736 specifies for each kind", () => {
    expect(AGENT_COMPONENT_FOOTPRINT_SOURCE).toEqual({
      tool: AgentComponentFootprintSource.ResultPayload,
      mcp: AgentComponentFootprintSource.ResultPayload,
      // The recorded orchestration ruling: it carries its own footprint.
      orchestration: AgentComponentFootprintSource.ResultPayload,
      command: AgentComponentFootprintSource.DefinitionBody,
      skill: AgentComponentFootprintSource.DefinitionBody,
      subagent: AgentComponentFootprintSource.ReturnedText,
      hook: AgentComponentFootprintSource.HookStdout,
    });
  });

  it("leaves no kind without a declared source", () => {
    for (const kind of SEVEN_INVOCATION_KINDS) {
      expect(AGENT_COMPONENT_FOOTPRINT_SOURCE[kind]).toBeDefined();
    }
  });
});

describe("estimateAgentComponentFootprintTokens", () => {
  it("counts ASCII at four characters per token", () => {
    expect(estimateAgentComponentFootprintTokens("a".repeat(400))).toBe(100);
  });

  it("counts each non-ASCII code point as a whole token", () => {
    expect(estimateAgentComponentFootprintTokens("日本語")).toBe(3);
  });

  it("does not double-count an astral character as a surrogate pair", () => {
    expect(estimateAgentComponentFootprintTokens("😀")).toBe(1);
  });

  it("counts empty text as a measured zero rather than refusing it", () => {
    expect(estimateAgentComponentFootprintTokens("")).toBe(0);
  });
});

describe("isValidAgentComponentFootprintTokens", () => {
  it("accepts zero and the safe-integer ceiling", () => {
    expect(isValidAgentComponentFootprintTokens(0)).toBe(true);
    expect(
      isValidAgentComponentFootprintTokens(
        AGENT_COMPONENT_INVOCATION_MAX_TOKENS
      )
    ).toBe(true);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    [
      "past the safe-integer ceiling",
      AGENT_COMPONENT_INVOCATION_MAX_TOKENS + 2,
    ],
  ])("refuses a %s count", (_label, value) => {
    expect(isValidAgentComponentFootprintTokens(value)).toBe(false);
  });
});

describe("resolveAgentComponentFootprint", () => {
  it("labels a derived count as estimated, never measured", () => {
    expect(resolveAgentComponentFootprint({ text: "a".repeat(40) })).toEqual({
      footprintTokens: 10,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
    });
  });

  it("returns nothing for absent text, so absent never reads as zero", () => {
    expect(resolveAgentComponentFootprint({ text: null })).toBeUndefined();
    expect(resolveAgentComponentFootprint({ text: undefined })).toBeUndefined();
  });

  it("distinguishes an empty injection from an absent one", () => {
    expect(resolveAgentComponentFootprint({ text: "" })?.footprintTokens).toBe(
      0
    );
  });
});

describe("agentComponentFootprintFromTokenCount", () => {
  it("labels a pre-counted footprint as estimated", () => {
    expect(agentComponentFootprintFromTokenCount(512)).toEqual({
      footprintTokens: 512,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
    });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["over the ceiling", AGENT_COMPONENT_INVOCATION_MAX_TOKENS + 2],
  ])("refuses a %s value rather than persisting it", (_label, value) => {
    expect(agentComponentFootprintFromTokenCount(value)).toBeUndefined();
  });
});
