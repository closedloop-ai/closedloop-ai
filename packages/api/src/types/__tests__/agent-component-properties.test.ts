import { describe, expect, it } from "vitest";
import {
  buildComponentProperties,
  inferComponentFormat,
} from "../agent-component-properties.js";

describe("inferComponentFormat", () => {
  it("prefers the real file extension from the path", () => {
    expect(inferComponentFormat("skill", "~/.claude/skills/x/SKILL.md")).toBe(
      "md"
    );
    expect(inferComponentFormat("hook", ".claude/hooks/guard.sh")).toBe("sh");
    expect(inferComponentFormat("config", "~/.codex/config.toml")).toBe("toml");
  });

  it("falls back to the kind's conventional format when path is extensionless", () => {
    expect(inferComponentFormat("mcp", ".mcp")).toBe("json");
    expect(inferComponentFormat("mcp", null)).toBe("json");
    expect(inferComponentFormat("workflow", "release")).toBe("yml");
    expect(inferComponentFormat("hook", "")).toBe("bash");
    expect(inferComponentFormat("subagent", undefined)).toBe("md");
    expect(inferComponentFormat("command", "review")).toBe("md");
  });
});

describe("buildComponentProperties", () => {
  it("always yields an honest { path, format } with no metadata", () => {
    expect(
      buildComponentProperties({ kind: "workflow", path: ".github/wf.yml" })
    ).toEqual({ path: ".github/wf.yml", format: "yml" });
  });

  it("reads well-typed per-kind extras from metadata", () => {
    const props = buildComponentProperties({
      kind: "subagent",
      path: ".claude/agents/a.md",
      metadata: {
        model: "opus",
        allowedTools: ["Read", "Bash"],
        maxConcurrency: 4,
        orchestrates: ["visual-qa"],
      },
    });
    expect(props).toEqual({
      path: ".claude/agents/a.md",
      format: "md",
      model: "opus",
      allowedTools: ["Read", "Bash"],
      maxConcurrency: 4,
      orchestrates: ["visual-qa"],
    });
  });

  it("attaches server info only for the mcp kind and only when well-formed", () => {
    const server = { url: "https://x/mcp", auth: "OAuth", health: "Connected" };
    expect(
      buildComponentProperties({
        kind: "mcp",
        path: ".mcp.json",
        metadata: { server },
      }).server
    ).toEqual(server);
    // Not mcp → server ignored.
    expect(
      buildComponentProperties({
        kind: "skill",
        path: "s.md",
        metadata: { server },
      }).server
    ).toBeUndefined();
    // Malformed server object → ignored, no fake fields.
    expect(
      buildComponentProperties({
        kind: "mcp",
        path: ".mcp.json",
        metadata: { server: { url: "https://x/mcp" } },
      }).server
    ).toBeUndefined();
  });

  it("ignores wrong-typed metadata values (never fakes a field)", () => {
    const props = buildComponentProperties({
      kind: "subagent",
      path: "a.md",
      metadata: {
        model: 123,
        allowedTools: ["ok", 5],
        orchestrates: "not-array",
      },
    });
    expect(props.model).toBeUndefined();
    expect(props.allowedTools).toBeUndefined();
    expect(props.orchestrates).toBeUndefined();
  });
});
