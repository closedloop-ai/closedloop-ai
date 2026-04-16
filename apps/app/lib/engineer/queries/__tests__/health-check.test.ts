import { describe, expect, it } from "vitest";
import { getRenderableHealthChecks } from "../health-check";

describe("getRenderableHealthChecks", () => {
  it("appends Claude and Codex MCP rows from mcpServers", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: true,
            version: "2.49.0",
          },
        ],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: true,
            serverName: "team-claude",
            matchedUrl: "https://example.com/mcp",
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
          codex: {
            available: false,
            serverName: null,
            matchedUrl: null,
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      },
      "https://example.com/mcp"
    );

    expect(checks).toEqual([
      expect.objectContaining({ label: "Git" }),
      expect.objectContaining({
        label: "Claude MCP",
        passed: true,
        version: "team-claude",
      }),
      expect.objectContaining({
        label: "Codex MCP",
        passed: false,
        error: "Not configured",
        required: false,
        remediation:
          "Install a user/global MCP server pointing to https://example.com/mcp. Project-local MCP installs are not supported.",
      }),
    ]);
  });

  it("omits empty MCP placeholders when no expected URL or match metadata exists", () => {
    // Pass null explicitly so the result is deterministic regardless of
    // NEXT_PUBLIC_MCP_SERVER_URL set in the local environment.
    const checks = getRenderableHealthChecks(
      {
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: true,
            version: "2.49.0",
          },
        ],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: false,
            serverName: null,
            matchedUrl: null,
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
          codex: {
            closedloopAvailable: false,
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      },
      null
    );

    expect(checks).toEqual([expect.objectContaining({ label: "Git" })]);
  });

  it("renders discovery failures distinctly from missing configuration", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: true,
            version: "2.49.0",
          },
        ],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: false,
            serverName: null,
            matchedUrl: null,
            checkedAt: "2026-04-13T18:41:00.000Z",
            error: "Discovery timed out",
          },
          codex: {
            available: false,
            serverName: "team-codex",
            matchedUrl: "https://example.com/mcp",
            checkedAt: "2026-04-13T18:41:00.000Z",
            error: "Status check timed out",
          },
        },
      },
      "https://example.com/mcp"
    );

    expect(checks).toEqual([
      expect.objectContaining({ label: "Git" }),
      expect.objectContaining({
        label: "Claude MCP",
        passed: false,
        error: "Discovery timed out",
      }),
      expect.objectContaining({
        label: "Codex MCP",
        passed: false,
        error: "Status check timed out",
        remediation:
          "Retry check. team-codex is configured for https://example.com/mcp",
      }),
    ]);
  });
});
