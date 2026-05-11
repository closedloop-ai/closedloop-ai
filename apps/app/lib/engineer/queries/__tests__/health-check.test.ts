import { describe, expect, it } from "vitest";
import {
  COMPUTE_TARGET_HEADER,
  GATEWAY_HEALTH_CHECK_PATH,
  GATEWAY_RELAY_HEALTH_CHECK_PATH,
} from "@/lib/engineer/constants";
import {
  buildHealthCheckRequest,
  getRenderableHealthChecks,
  healthCheckOptions,
} from "../health-check";

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

  it("normalizes app-version responses into required blocking rows", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [
          {
            id: "app-version",
            label: "Desktop App Version",
            required: false,
            passed: false,
            version: "0.14.10",
            error: "Update available: 0.14.11",
            remediation: "Open the ClosedLoop Gateway app to update",
            updateAttempted: true,
            updateOutcome: "failed",
            updatePluginIds: ["plugin-code"],
            remediationLinks: [
              {
                label: "Enable ClosedLoop plugin autoupdate",
                url: "https://github.com/closedloop-ai/claude-plugins#quick-start",
              },
            ],
          },
        ],
        allRequiredPassed: true,
      },
      null
    );

    expect(checks).toEqual([
      {
        id: "app-version",
        label: "Gateway Version",
        required: true,
        passed: false,
        version: "0.14.10",
        error: "Update available: 0.14.11",
        remediation: "Open the ClosedLoop Gateway app to update",
        updateAttempted: true,
        updateOutcome: "failed",
        updatePluginIds: ["plugin-code"],
        remediationLinks: [
          {
            label: "Enable ClosedLoop plugin autoupdate",
            url: "https://github.com/closedloop-ai/claude-plugins#quick-start",
          },
        ],
      },
    ]);
  });

  it("normalizes plugin-version aggregate rows to Plugin Updates", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [
          {
            id: "plugin-versions",
            label: "Plugin Versions (@closedloop-ai)",
            required: false,
            passed: true,
          },
        ],
        allRequiredPassed: true,
      },
      null
    );

    expect(checks).toEqual([
      {
        id: "plugin-versions",
        label: "Plugin Updates",
        required: false,
        passed: true,
      },
    ]);
  });
});

describe("healthCheckOptions", () => {
  it("keys and builds the relay request with latestVersion when supplied", () => {
    const options = healthCheckOptions(
      "cloud-relay:target-1",
      "https://example.com/mcp",
      { latestVersion: "9.9.9", relayTargetId: "target-1" }
    );

    expect(options.queryKey).toEqual([
      "health-check",
      "cloud-relay:target-1",
      "https://example.com/mcp",
      "9.9.9",
      "plugin-no-auto-update",
    ]);

    const request = buildHealthCheckRequest({
      expectedMcpUrl: "https://example.com/mcp",
      latestVersion: "9.9.9",
      relayTargetId: "target-1",
    });

    expect(request).toEqual({
      url: `${GATEWAY_RELAY_HEALTH_CHECK_PATH}?expectedMcpUrl=https%3A%2F%2Fexample.com%2Fmcp&latestVersion=9.9.9`,
      init: {
        headers: {
          [COMPUTE_TARGET_HEADER]: "target-1",
        },
      },
    });
  });

  it("builds a direct gateway request with latestVersion when supplied", () => {
    const request = buildHealthCheckRequest({
      expectedMcpUrl: null,
      latestVersion: "9.9.9",
    });

    expect(request).toEqual({
      url: `${GATEWAY_HEALTH_CHECK_PATH}?latestVersion=9.9.9`,
    });
  });

  it("omits latestVersion from the request when null or empty", () => {
    const nullRequest = buildHealthCheckRequest({
      expectedMcpUrl: "https://example.com/mcp",
      latestVersion: null,
      relayTargetId: "target-1",
    });
    const omittedRequest = buildHealthCheckRequest({
      expectedMcpUrl: "https://example.com/mcp",
      relayTargetId: "target-1",
    });
    const emptyRequest = buildHealthCheckRequest({
      expectedMcpUrl: "https://example.com/mcp",
      latestVersion: "",
      relayTargetId: "target-1",
    });
    const options = healthCheckOptions("cloud-relay:target-1", null, {
      latestVersion: null,
      relayTargetId: "target-1",
    });

    expect(nullRequest.url).toBe(
      `${GATEWAY_RELAY_HEALTH_CHECK_PATH}?expectedMcpUrl=https%3A%2F%2Fexample.com%2Fmcp`
    );
    expect(omittedRequest.url).toBe(
      `${GATEWAY_RELAY_HEALTH_CHECK_PATH}?expectedMcpUrl=https%3A%2F%2Fexample.com%2Fmcp`
    );
    expect(emptyRequest.url).toBe(
      `${GATEWAY_RELAY_HEALTH_CHECK_PATH}?expectedMcpUrl=https%3A%2F%2Fexample.com%2Fmcp`
    );
    expect(options.queryKey).toEqual([
      "health-check",
      "cloud-relay:target-1",
      null,
      null,
      "plugin-no-auto-update",
    ]);
  });

  it("includes plugin auto-update mode in the key and request URL only when enabled", () => {
    const enabledOptions = healthCheckOptions(
      "cloud-relay:target-1",
      "https://example.com/mcp",
      {
        latestVersion: "9.9.9",
        pluginAutoUpdateEnabled: true,
        relayTargetId: "target-1",
      }
    );
    const enabledRequest = buildHealthCheckRequest({
      expectedMcpUrl: "https://example.com/mcp",
      latestVersion: "9.9.9",
      pluginAutoUpdateEnabled: true,
      relayTargetId: "target-1",
    });
    const disabledRequest = buildHealthCheckRequest({
      expectedMcpUrl: "https://example.com/mcp",
      latestVersion: "9.9.9",
      pluginAutoUpdateEnabled: false,
      relayTargetId: "target-1",
    });

    expect(enabledOptions.queryKey).toEqual([
      "health-check",
      "cloud-relay:target-1",
      "https://example.com/mcp",
      "9.9.9",
      "plugin-auto-update",
    ]);
    expect(enabledRequest.url).toBe(
      `${GATEWAY_RELAY_HEALTH_CHECK_PATH}?expectedMcpUrl=https%3A%2F%2Fexample.com%2Fmcp&latestVersion=9.9.9&pluginAutoUpdate=1`
    );
    expect(disabledRequest.url).toBe(
      `${GATEWAY_RELAY_HEALTH_CHECK_PATH}?expectedMcpUrl=https%3A%2F%2Fexample.com%2Fmcp&latestVersion=9.9.9`
    );
  });
});
