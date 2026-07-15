/**
 * T-18.1(b) — Plugin kind type-guard tests (AC-014, AC-025, AC-026).
 *
 * Assert:
 * - `AgentComponentKind.Plugin === 'plugin'` (canonical value)
 * - `AgentComponentKind` has NO `Pack` / `pack` entry (vocabulary deprecated)
 * - All expected kinds are present (regression guard against future removals)
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";

describe("AgentComponentKind — Plugin value T-18.1(b)", () => {
  it("AgentComponentKind.Plugin === 'plugin'", () => {
    expect(AgentComponentKind.Plugin).toBe("plugin");
  });

  it("AgentComponentKind has no Pack / pack entry (vocabulary deprecated, AC-026)", () => {
    const values = Object.values(AgentComponentKind) as string[];
    expect(values).not.toContain("pack");
    expect(values).not.toContain("Pack");
  });

  it("AgentComponentKind keys have no Pack entry", () => {
    const keys = Object.keys(AgentComponentKind);
    expect(keys).not.toContain("Pack");
  });

  it("all expected AgentComponentKind values are present", () => {
    // Regression guard: the canonical 9-value set must all be present.
    expect(AgentComponentKind.Subagent).toBe("subagent");
    expect(AgentComponentKind.Command).toBe("command");
    expect(AgentComponentKind.Skill).toBe("skill");
    expect(AgentComponentKind.Workflow).toBe("workflow");
    expect(AgentComponentKind.Mcp).toBe("mcp");
    expect(AgentComponentKind.Hook).toBe("hook");
    expect(AgentComponentKind.Config).toBe("config");
    expect(AgentComponentKind.Plugin).toBe("plugin");
    // FEA-3048: first-class observable-only Tool kind.
    expect(AgentComponentKind.Tool).toBe("tool");
  });

  it("AgentComponentKind has exactly 9 values (Plugin + Tool, no extras)", () => {
    expect(Object.keys(AgentComponentKind)).toHaveLength(9);
  });
});
