import { HealthCheckRepairAction } from "@repo/api/src/types/compute-target";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRenderableHealthChecks, healthCheckOptions } from "../health-check";

/**
 * MCP repair annotation (ISS-5435), split out of `health-check.test.ts` so that
 * file stays under the 1,000-line ceiling.
 *
 * The two MCP rows are the only System Check rows the web synthesizes rather
 * than receives, so they are also the only ones whose repair verdict has to
 * cross a boundary this file owns: gateway `mcpServers[provider].repair` →
 * schema → synthesized `<provider>-mcp` row.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getRenderableHealthChecks — MCP repair annotation (ISS-5435)", () => {
  const unconfiguredClaude = {
    available: false,
    serverName: null,
    matchedUrl: null,
    checkedAt: "2026-04-13T18:41:00.000Z",
  };

  function renderMcpRow(claude: Record<string, unknown>) {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: false,
        mcpServers: { claude },
      } as never,
      "https://mcp.example.com/mcp"
    );
    return checks?.find((check) => check.id === "claude-mcp");
  }

  it("carries the gateway repair verdict onto the synthesized MCP row", () => {
    // The MCP rows are the only System Check rows the web builds itself, so the
    // gateway's verdict has to be copied across or `getRepairableChecks` can
    // never see it and the control is never offered for MCP.
    const row = renderMcpRow({
      ...unconfiguredClaude,
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
      },
    });

    expect(row?.passed).toBe(false);
    expect(row?.repair).toEqual({
      repairable: true,
      action: HealthCheckRepairAction.ConfigureMcp,
    });
  });

  it("carries a not-repairable reason so the row is never a dead affordance", () => {
    const row = renderMcpRow({
      ...unconfiguredClaude,
      serverName: "closedloop",
      repair: { repairable: false, reason: "Needs a sign-in on that machine." },
    });

    expect(row?.repair).toEqual({
      repairable: false,
      reason: "Needs a sign-in on that machine.",
    });
  });

  it("leaves a PASSING MCP row unannotated", () => {
    // Matches the gateway's own `annotateRepairability`: a green row has
    // nothing to repair, and offering one would be a lie about its state.
    const row = renderMcpRow({
      ...unconfiguredClaude,
      available: true,
      serverName: "closedloop",
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
      },
    });

    expect(row?.passed).toBe(true);
    expect(row?.repair).toBeUndefined();
  });

  it("drops an unknown MCP repair action at the network parse boundary", async () => {
    // The unknown-action preprocessor lives on `healthCheckResponseSchema`, so
    // this has to go through the real query function — `getRenderableHealthChecks`
    // is handed an already-parsed response and applies no schema of its own.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          checks: [],
          allRequiredPassed: false,
          mcpServers: {
            claude: {
              ...unconfiguredClaude,
              repair: { repairable: true, action: "reboot_the_universe" },
            },
          },
        })
      )
    );

    const response = await runHealthCheckQuery(
      healthCheckOptions("default", "https://mcp.example.com/mcp")
    );
    const claude = response.mcpServers?.claude as {
      repair?: { repairable: boolean; action?: string };
    };

    // The entry survives, and `repairable` without a recognised action simply
    // means "this build cannot drive it" — the row is not rejected wholesale.
    expect(claude.repair?.repairable).toBe(true);
    expect(claude.repair?.action).toBeUndefined();
  });

  it("preserves a known MCP repair action across the network parse boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          checks: [],
          allRequiredPassed: false,
          mcpServers: {
            claude: {
              ...unconfiguredClaude,
              repair: {
                repairable: true,
                action: HealthCheckRepairAction.ConfigureMcp,
              },
            },
          },
        })
      )
    );

    const response = await runHealthCheckQuery(
      healthCheckOptions("default", "https://mcp.example.com/mcp")
    );
    const claude = response.mcpServers?.claude as {
      repair?: { action?: string };
    };

    expect(claude.repair?.action).toBe(HealthCheckRepairAction.ConfigureMcp);
  });

  it("reads a gateway that predates MCP repair as not repairable", () => {
    const row = renderMcpRow(unconfiguredClaude);

    expect(row?.passed).toBe(false);
    expect(row?.repair).toBeUndefined();
  });
});

function runHealthCheckQuery(
  options: ReturnType<typeof healthCheckOptions>,
  signal = new AbortController().signal
) {
  if (typeof options.queryFn !== "function") {
    throw new Error("Expected health-check query function");
  }

  return options.queryFn({
    queryKey: options.queryKey,
    signal,
  } as never);
}
