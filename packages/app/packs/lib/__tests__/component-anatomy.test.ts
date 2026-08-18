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
  unknownFields: [],
};

const mcpDraft: ComponentDraft = {
  name: "posthog",
  description: "PostHog MCP",
  fields: { command: "npx", args: "-y, @posthog/mcp" },
  body: "",
  unknownFields: [],
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
    expect(parsed).toEqual({
      name: "",
      description: "",
      fields: {},
      body: "",
      unknownFields: [],
    });
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

// FEA-3164: editing a component must NOT silently strip frontmatter/config keys
// the editor's anatomy doesn't model. These are the terminal round-trip proofs.
describe("unknown-frontmatter passthrough (FEA-3164)", () => {
  it("captures unknown frontmatter keys verbatim on parse (markdown)", () => {
    const parsed = parseComponentContent(
      "agent",
      '---\nname: "code-reviewer"\ndescription: Reviews diffs\nmodel: opus\ncolor: amber\ntags: [ci, security]\n---\n\nYou review code.'
    );
    // Known keys land in their modeled slots…
    expect(parsed.name).toBe("code-reviewer");
    expect(parsed.fields.model).toBe("opus");
    // …unknown keys are preserved (original key casing + raw value text).
    expect(parsed.unknownFields).toEqual([
      { key: "color", raw: " amber" },
      { key: "tags", raw: " [ci, security]" },
    ]);
  });

  it("preserves unknown frontmatter keys when a known field is edited (markdown)", () => {
    const original =
      "---\nname: code-reviewer\ndescription: Reviews diffs\nmodel: opus\ncolor: amber\nCustomKey: keep-me\ntags: [ci, security]\n---\n\nYou review code.";
    const parsed = parseComponentContent("agent", original);

    // Simulate the editor: user only tweaks the description (a known field).
    const edited = { ...parsed, description: "Reviews pull-request diffs" };
    const reassembled = assembleComponentContent("agent", edited);

    // Edited known field updates…
    expect(reassembled).toContain("description: Reviews pull-request diffs");
    // …every unknown key survives byte-for-byte, with casing + ordering intact.
    expect(reassembled).toContain("color: amber");
    expect(reassembled).toContain("CustomKey: keep-me");
    expect(reassembled).toContain("tags: [ci, security]");
    expect(reassembled.indexOf("color: amber")).toBeLessThan(
      reassembled.indexOf("CustomKey: keep-me")
    );
    expect(reassembled.indexOf("CustomKey: keep-me")).toBeLessThan(
      reassembled.indexOf("tags: [ci, security]")
    );

    // And the unknown keys still round-trip on a second parse.
    const reparsed = parseComponentContent("agent", reassembled);
    expect(reparsed.unknownFields).toEqual([
      { key: "color", raw: " amber" },
      { key: "CustomKey", raw: " keep-me" },
      { key: "tags", raw: " [ci, security]" },
    ]);
  });

  it("is idempotent for an untouched markdown component (no drift)", () => {
    const original =
      "---\nname: code-reviewer\ndescription: Reviews diffs\nmodel: opus\ncolor: amber\ntags: [ci, security]\n---\n\nYou review code.";
    const roundTripped = assembleComponentContent(
      "agent",
      parseComponentContent("agent", original)
    );
    // Re-serializing a parsed-but-unedited component reproduces every key/value.
    expect(roundTripped).toContain("color: amber");
    expect(roundTripped).toContain("tags: [ci, security]");
    expect(roundTripped).toContain("model: opus");
  });

  it("preserves unknown config keys through edit (JSON kind)", () => {
    const original = JSON.stringify(
      {
        name: "posthog",
        command: "npx",
        args: ["-y", "@posthog/mcp"],
        env: { POSTHOG_API_KEY: "x" },
        disabled: false,
      },
      null,
      2
    );
    const parsed = parseComponentContent("mcp", original);
    expect(parsed.unknownFields.map((u) => u.key)).toEqual(["env", "disabled"]);

    // Edit a known field (command) and re-assemble.
    const reassembled = assembleComponentContent("mcp", {
      ...parsed,
      fields: { ...parsed.fields, command: "uvx" },
    });
    const obj = JSON.parse(reassembled);
    expect(obj.command).toBe("uvx");
    // Unknown keys survive with their original (non-string) types.
    expect(obj.env).toEqual({ POSTHOG_API_KEY: "x" });
    expect(obj.disabled).toBe(false);
  });

  it("dedupes duplicate/case-variant frontmatter keys (last value wins, one emit)", () => {
    // A known key (description) and an unknown key (Color/color) each appear
    // twice with differing casing. The later raw value must win (matching the
    // prior last-occurrence-wins parse), and each key must be emitted once so
    // it does not double-write on save.
    const parsed = parseComponentContent(
      "agent",
      "---\nname: code-reviewer\ndescription: first\nColor: amber\ndescription: second\ncolor: teal\n---\n\nBody."
    );
    // Known key: last occurrence wins.
    expect(parsed.description).toBe("second");
    // Unknown key: single entry (first casing + position), last value wins.
    expect(parsed.unknownFields).toEqual([{ key: "Color", raw: " teal" }]);

    // On reassemble the deduped unknown key is written exactly once.
    const reassembled = assembleComponentContent("agent", parsed);
    expect(reassembled.match(/^Color:/gm)?.length ?? 0).toBe(1);
  });
});
