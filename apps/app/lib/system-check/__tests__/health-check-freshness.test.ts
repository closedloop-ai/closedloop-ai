import { describe, expect, it } from "vitest";
import type { HealthCheckResponse } from "@/lib/engineer/queries/health-check";
import {
  HEALTH_CHECK_CLI_FRESHNESS_MS,
  HEALTH_CHECK_DEFAULT_FRESHNESS_MS,
  isHealthCheckCacheEntryFresh,
} from "../health-check-freshness";

const now = new Date("2026-05-08T16:00:00.000Z").getTime();

function healthCheck(
  checks: HealthCheckResponse["checks"]
): HealthCheckResponse {
  return {
    checks,
    allRequiredPassed: checks.every((check) => !check.required || check.passed),
  };
}

describe("health-check freshness", () => {
  it("keeps CLI-only required checks fresh for seven days", () => {
    expect(
      isHealthCheckCacheEntryFresh({
        entry: {
          data: healthCheck([
            { id: "git", label: "Git", required: true, passed: true },
            {
              id: "claude-cli",
              label: "Claude CLI",
              required: true,
              passed: true,
            },
          ]),
          checkedAt: now - HEALTH_CHECK_CLI_FRESHNESS_MS,
        },
        expectedMcpUrl: null,
        requiredOnly: true,
        now,
      })
    ).toBe(true);
  });

  it("expires non-CLI required checks after one day", () => {
    expect(
      isHealthCheckCacheEntryFresh({
        entry: {
          data: healthCheck([
            {
              id: "github-auth",
              label: "GitHub Auth",
              required: true,
              passed: true,
            },
          ]),
          checkedAt: now - HEALTH_CHECK_DEFAULT_FRESHNESS_MS - 1,
        },
        expectedMcpUrl: null,
        requiredOnly: true,
        now,
      })
    ).toBe(false);
  });

  it("expires app version checks when the latest version changed", () => {
    expect(
      isHealthCheckCacheEntryFresh({
        entry: {
          data: healthCheck([
            {
              id: "app-version",
              label: "Gateway Version",
              required: true,
              passed: true,
            },
          ]),
          checkedAt: now,
          latestVersion: "1.2.3",
        },
        expectedMcpUrl: null,
        latestVersion: "1.2.4",
        requiredOnly: true,
        now,
      })
    ).toBe(false);
  });

  it("expires MCP checks when the expected MCP URL changed", () => {
    expect(
      isHealthCheckCacheEntryFresh({
        entry: {
          data: {
            checks: [],
            allRequiredPassed: true,
            mcpServers: {
              claude: {
                available: true,
                serverName: "closedloop",
                matchedUrl: "https://old.example.com/mcp",
                checkedAt: "2026-05-08T16:00:00.000Z",
              },
              codex: {
                available: true,
                serverName: "closedloop",
                matchedUrl: "https://old.example.com/mcp",
                checkedAt: "2026-05-08T16:00:00.000Z",
              },
            },
          },
          checkedAt: now,
          expectedMcpUrl: "https://old.example.com/mcp",
        },
        expectedMcpUrl: "https://new.example.com/mcp",
        now,
      })
    ).toBe(false);
  });
});
