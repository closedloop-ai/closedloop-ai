import { HarnessName } from "@repo/crewd/model";
import { describe, expect, it } from "vitest";
import { AgentComponentKind } from "../agent-component";
import type {
  ConversionDryRunComponent,
  ConversionDryRunRequest,
} from "../harness-conversion";
import {
  agentComponentKindSchema,
  ConversionSupport,
  conversionDryRunRequestSchema,
  HARNESS_CONVERSION_CAPABILITIES,
  planConversionDryRun,
  resolveConversionCapability,
} from "../harness-conversion";

const ALL_KINDS = Object.values(AgentComponentKind);
const ALL_HARNESSES = Object.values(HarnessName);
// Observable-only kinds are not installable/authored, so they are unconvertible
// in EVERY direction — identity included.
const OBSERVABLE_ONLY_KINDS: AgentComponentKind[] = [
  AgentComponentKind.Mcp,
  AgentComponentKind.Tool,
  AgentComponentKind.Orchestration,
];
const INSTALLABLE_KINDS = ALL_KINDS.filter(
  (kind) => !OBSERVABLE_ONLY_KINDS.includes(kind)
);

describe("HARNESS_CONVERSION_CAPABILITIES (FEA-4078)", () => {
  it("is exhaustive over every componentKind × source × target harness", () => {
    for (const kind of ALL_KINDS) {
      const matrix = HARNESS_CONVERSION_CAPABILITIES[kind];
      expect(matrix, `missing matrix for kind ${kind}`).toBeDefined();
      for (const source of ALL_HARNESSES) {
        for (const target of ALL_HARNESSES) {
          const cell = matrix[source]?.[target];
          expect(
            cell,
            `missing cell for ${kind} ${source}->${target}`
          ).toBeDefined();
          expect(Object.values(ConversionSupport)).toContain(cell.support);
          expect(Array.isArray(cell.droppedFields)).toBe(true);
        }
      }
    }
  });

  it("converts every installable kind to itself losslessly (identity supported, no drops)", () => {
    for (const kind of INSTALLABLE_KINDS) {
      for (const harness of ALL_HARNESSES) {
        const cell = resolveConversionCapability(kind, harness, harness);
        expect(cell.support).toBe(ConversionSupport.Supported);
        expect(cell.droppedFields).toEqual([]);
      }
    }
  });

  it("keeps droppedFields non-empty ONLY for partial cells", () => {
    for (const kind of ALL_KINDS) {
      for (const source of ALL_HARNESSES) {
        for (const target of ALL_HARNESSES) {
          const cell = resolveConversionCapability(kind, source, target);
          if (cell.support === ConversionSupport.Partial) {
            expect(cell.droppedFields.length).toBeGreaterThan(0);
          } else {
            expect(cell.droppedFields).toEqual([]);
          }
        }
      }
    }
  });

  it("marks portable text kinds fully convertible across every pair", () => {
    for (const kind of [
      AgentComponentKind.Skill,
      AgentComponentKind.Command,
      AgentComponentKind.Config,
    ]) {
      for (const source of ALL_HARNESSES) {
        for (const target of ALL_HARNESSES) {
          expect(
            resolveConversionCapability(kind, source, target).support
          ).toBe(ConversionSupport.Supported);
        }
      }
    }
  });

  it("marks observable-only kinds unconvertible in every cross-harness direction", () => {
    for (const kind of OBSERVABLE_ONLY_KINDS) {
      for (const source of ALL_HARNESSES) {
        for (const target of ALL_HARNESSES) {
          expect(
            resolveConversionCapability(kind, source, target).support
          ).toBe(ConversionSupport.Unsupported);
        }
      }
    }
  });

  it("marks hooks unsupported cross-harness but supported to itself", () => {
    expect(
      resolveConversionCapability(
        AgentComponentKind.Hook,
        HarnessName.Claude,
        HarnessName.Codex
      ).support
    ).toBe(ConversionSupport.Unsupported);
    expect(
      resolveConversionCapability(
        AgentComponentKind.Hook,
        HarnessName.Claude,
        HarnessName.Claude
      ).support
    ).toBe(ConversionSupport.Supported);
  });

  it("drops the workflow's own orchestration fields cross-harness (not a harness capability)", () => {
    const crossHarness = resolveConversionCapability(
      AgentComponentKind.Workflow,
      HarnessName.Claude,
      HarnessName.Codex
    );
    expect(crossHarness.support).toBe(ConversionSupport.Partial);
    // Workflow's own component fields per AgentComponentDetail.
    expect(crossHarness.droppedFields).toContain("maxConcurrency");
    expect(crossHarness.droppedFields).toContain("orchestrates");
    // nativeSchedule is a HARNESS capability, not a Workflow field — it must NOT
    // be reported as a dropped Workflow field.
    expect(crossHarness.droppedFields).not.toContain("nativeSchedule");
  });

  it("makes subagent conversion lossy FROM claude but lossless INTO claude", () => {
    const claudeToCodex = resolveConversionCapability(
      AgentComponentKind.Subagent,
      HarnessName.Claude,
      HarnessName.Codex
    );
    expect(claudeToCodex.support).toBe(ConversionSupport.Partial);
    expect(claudeToCodex.droppedFields).toContain("model");
    expect(claudeToCodex.droppedFields).toContain("allowedTools");

    const codexToClaude = resolveConversionCapability(
      AgentComponentKind.Subagent,
      HarnessName.Codex,
      HarnessName.Claude
    );
    expect(codexToClaude.support).toBe(ConversionSupport.Supported);
    expect(codexToClaude.droppedFields).toEqual([]);
  });
});

describe("agentComponentKindSchema", () => {
  it("accepts every canonical AgentComponentKind value", () => {
    for (const kind of ALL_KINDS) {
      expect(agentComponentKindSchema.parse(kind)).toBe(kind);
    }
  });

  it("rejects a non-kind string", () => {
    expect(agentComponentKindSchema.safeParse("not-a-kind").success).toBe(
      false
    );
  });
});

describe("planConversionDryRun (FEA-4078)", () => {
  const claudeSkill: ConversionDryRunComponent = {
    id: "c1",
    name: "My Skill",
    kind: AgentComponentKind.Skill,
    currentHarness: HarnessName.Claude,
  };
  const claudeSubagent: ConversionDryRunComponent = {
    id: "c2",
    name: "My Subagent",
    kind: AgentComponentKind.Subagent,
    currentHarness: HarnessName.Claude,
  };
  const claudeHook: ConversionDryRunComponent = {
    id: "c3",
    name: "My Hook",
    kind: AgentComponentKind.Hook,
    currentHarness: HarnessName.Claude,
  };
  const claudeMcp: ConversionDryRunComponent = {
    id: "c4",
    name: "My MCP",
    kind: AgentComponentKind.Mcp,
    currentHarness: HarnessName.Claude,
  };

  it("plans convertible components and skips unconvertible ones for a target", () => {
    const request: ConversionDryRunRequest = {
      targetHarness: HarnessName.Codex,
      components: [claudeSkill, claudeSubagent, claudeHook, claudeMcp],
    };

    const result = planConversionDryRun(request);

    expect(result.targetHarness).toBe(HarnessName.Codex);
    expect(result.conversions.map((c) => c.identity.id)).toEqual(["c1", "c2"]);
    expect(result.skips.map((s) => s.id)).toEqual(["c3", "c4"]);
  });

  it("reports the correct support level and dropped fields per conversion", () => {
    const result = planConversionDryRun({
      targetHarness: HarnessName.Codex,
      components: [claudeSkill, claudeSubagent],
    });

    const skill = result.conversions.find((c) => c.identity.id === "c1");
    expect(skill?.capability.support).toBe(ConversionSupport.Supported);
    expect(skill?.capability.droppedFields).toEqual([]);

    const subagent = result.conversions.find((c) => c.identity.id === "c2");
    expect(subagent?.capability.support).toBe(ConversionSupport.Partial);
    expect(subagent?.capability.droppedFields).toContain("model");
  });

  it("defaults provenance to currentHarness when sourceHarness is omitted", () => {
    const result = planConversionDryRun({
      targetHarness: HarnessName.Opencode,
      components: [claudeSubagent],
    });

    const [conversion] = result.conversions;
    expect(conversion.identity.sourceHarness).toBe(HarnessName.Claude);
    expect(conversion.identity.currentHarness).toBe(HarnessName.Claude);
    expect(conversion.identity.targetHarness).toBe(HarnessName.Opencode);
    expect(conversion.identity.name).toBe("My Subagent");
  });

  it("resolves capability from currentHarness, not provenance, on a second hop", () => {
    // A subagent originally authored for Claude, already converted to Codex, is
    // now being converted Codex->OpenCode. The matrix must be keyed on the
    // CURRENT (codex) format: Codex->OpenCode subagent is lossless (SUPPORTED),
    // NOT re-charged for the Claude-preamble loss that happened on the first hop
    // (which a provenance-keyed lookup of Claude->OpenCode would wrongly report
    // as PARTIAL). Original Claude provenance is still preserved untouched.
    const alreadyConverted: ConversionDryRunComponent = {
      id: "c2b",
      name: "My Subagent",
      kind: AgentComponentKind.Subagent,
      currentHarness: HarnessName.Codex,
      sourceHarness: HarnessName.Claude,
    };
    const result = planConversionDryRun({
      targetHarness: HarnessName.Opencode,
      components: [alreadyConverted],
    });

    const [conversion] = result.conversions;
    expect(conversion.capability.support).toBe(ConversionSupport.Supported);
    expect(conversion.capability.droppedFields).toEqual([]);
    expect(conversion.identity.currentHarness).toBe(HarnessName.Codex);
    expect(conversion.identity.sourceHarness).toBe(HarnessName.Claude);
    expect(conversion.identity.targetHarness).toBe(HarnessName.Opencode);
  });

  it("carries the unsupported capability plus both harness fields onto each skip", () => {
    const result = planConversionDryRun({
      targetHarness: HarnessName.Codex,
      components: [claudeHook],
    });

    const [skip] = result.skips;
    expect(skip.capability.support).toBe(ConversionSupport.Unsupported);
    expect(skip.sourceHarness).toBe(HarnessName.Claude);
    expect(skip.currentHarness).toBe(HarnessName.Claude);
    expect(skip.targetHarness).toBe(HarnessName.Codex);
  });

  it("converts installable kinds to their own harness losslessly but still skips observable-only kinds", () => {
    const result = planConversionDryRun({
      targetHarness: HarnessName.Claude,
      components: [claudeSkill, claudeSubagent, claudeHook, claudeMcp],
    });

    // Skill/Subagent/Hook convert losslessly to their own harness (identity),
    // but MCP is observable-only — unconvertible even to itself — so it skips.
    expect(result.conversions.map((c) => c.identity.id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(result.skips.map((s) => s.id)).toEqual(["c4"]);
    for (const conversion of result.conversions) {
      expect(conversion.capability.support).toBe(ConversionSupport.Supported);
    }
  });

  it("returns empty plan for empty component set", () => {
    const result = planConversionDryRun({
      targetHarness: HarnessName.Codex,
      components: [],
    });
    expect(result.conversions).toEqual([]);
    expect(result.skips).toEqual([]);
  });
});

describe("conversionDryRunRequestSchema", () => {
  it("parses a valid request with only the required currentHarness", () => {
    const parsed = conversionDryRunRequestSchema.parse({
      targetHarness: HarnessName.Codex,
      components: [
        {
          id: "c1",
          name: "My Skill",
          kind: AgentComponentKind.Skill,
          currentHarness: HarnessName.Claude,
        },
      ],
    });
    expect(parsed.targetHarness).toBe(HarnessName.Codex);
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components[0].currentHarness).toBe(HarnessName.Claude);
    expect(parsed.components[0].sourceHarness).toBeUndefined();
  });

  it("parses a request that carries distinct provenance", () => {
    const parsed = conversionDryRunRequestSchema.parse({
      targetHarness: HarnessName.Opencode,
      components: [
        {
          id: "c1",
          name: "Converted Subagent",
          kind: AgentComponentKind.Subagent,
          currentHarness: HarnessName.Codex,
          sourceHarness: HarnessName.Claude,
        },
      ],
    });
    expect(parsed.components[0].currentHarness).toBe(HarnessName.Codex);
    expect(parsed.components[0].sourceHarness).toBe(HarnessName.Claude);
  });

  it("rejects a component missing the required currentHarness", () => {
    const result = conversionDryRunRequestSchema.safeParse({
      targetHarness: HarnessName.Codex,
      components: [
        {
          id: "c1",
          name: "My Skill",
          kind: AgentComponentKind.Skill,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown target harness", () => {
    const result = conversionDryRunRequestSchema.safeParse({
      targetHarness: "gemini",
      components: [],
    });
    expect(result.success).toBe(false);
  });
});
