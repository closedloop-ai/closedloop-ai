/**
 * @file component-anatomy.test.ts
 * @description Round-trip tests for assembling/parsing a component's authored
 * content across markdown (frontmatter + body) and JSON-config kinds.
 */
import { describe, expect, it } from "vitest";
import {
  assembleComponentContent,
  type ComponentDraft,
  parseComponentContent,
} from "../component-anatomy";

const skillDraft: ComponentDraft = {
  name: "extract-plan",
  description: "Sync plan.md with plan.json",
  fields: { "allowed-tools": "Read, Write" },
  body: "# Extract plan\n\nDo the thing.",
};

const mcpDraft: ComponentDraft = {
  name: "posthog",
  description: "PostHog MCP",
  fields: { command: "npx", args: "-y, @posthog/mcp" },
  body: "",
};

describe("assembleComponentContent (markdown kinds)", () => {
  it("emits frontmatter + body for a skill", () => {
    const content = assembleComponentContent("skill", skillDraft);
    expect(content).toContain("---\nname: extract-plan");
    expect(content).toContain("description: Sync plan.md with plan.json");
    expect(content).toContain("allowed-tools: [Read, Write]");
    expect(content).toContain("# Extract plan");
  });

  it("round-trips a skill through parse", () => {
    const content = assembleComponentContent("skill", skillDraft);
    const parsed = parseComponentContent("skill", content);
    expect(parsed.name).toBe("extract-plan");
    expect(parsed.description).toBe("Sync plan.md with plan.json");
    expect(parsed.fields["allowed-tools"]).toBe("Read, Write");
    expect(parsed.body).toBe("# Extract plan\n\nDo the thing.");
  });
});

describe("assembleComponentContent (config kinds)", () => {
  it("emits a JSON config object for an MCP", () => {
    const content = assembleComponentContent("mcp", mcpDraft);
    const obj = JSON.parse(content);
    expect(obj.name).toBe("posthog");
    expect(obj.command).toBe("npx");
    expect(obj.args).toEqual(["-y", "@posthog/mcp"]);
  });

  it("round-trips an MCP through parse", () => {
    const content = assembleComponentContent("mcp", mcpDraft);
    const parsed = parseComponentContent("mcp", content);
    expect(parsed.name).toBe("posthog");
    expect(parsed.fields.command).toBe("npx");
    expect(parsed.fields.args).toBe("-y, @posthog/mcp");
  });
});

describe("parseComponentContent tolerance", () => {
  it("returns empty draft for null content", () => {
    const parsed = parseComponentContent("skill", null);
    expect(parsed).toEqual({ name: "", description: "", fields: {}, body: "" });
  });

  it("parses hand-authored frontmatter with quotes + unknown keys", () => {
    const parsed = parseComponentContent(
      "agent",
      '---\nname: "code-reviewer"\ndescription: Reviews diffs\nmodel: opus\nunknown: x\n---\n\nYou review code.'
    );
    expect(parsed.name).toBe("code-reviewer");
    expect(parsed.fields.model).toBe("opus");
    expect(parsed.body).toBe("You review code.");
  });

  it("falls back to empty draft on invalid JSON for a config kind", () => {
    const parsed = parseComponentContent("hook", "{ not json");
    expect(parsed.name).toBe("");
  });
});
