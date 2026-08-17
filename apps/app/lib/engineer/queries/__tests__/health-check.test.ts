import { CheckSeverity } from "@repo/api/src/types/compute-target";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTE_TARGET_HEADER } from "@/lib/desktop-command-signing/constants";
import {
  GATEWAY_HEALTH_CHECK_PATH,
  GATEWAY_RELAY_HEALTH_CHECK_PATH,
} from "@/lib/engineer/constants";
import { HealthCheckFailureKind } from "@/lib/system-check/health-check-failure";
import { PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS } from "@/lib/system-check/health-check-timeouts";
import {
  buildHealthCheckRequest,
  getRenderableHealthChecks,
  HEALTH_CHECK_QUERY_STALE_TIME_MS,
  healthCheckOptions,
} from "../health-check";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("normalizes an old gateway's blocking app-version row into a non-blocking warning", () => {
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
            remediation: "Open the Closedloop Gateway app to update",
            updateAttempted: true,
            updateOutcome: "failed",
            updatePluginIds: ["plugin-code"],
            remediationLinks: [
              {
                label: "Update Closedloop plugins manually",
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
        // ISS-5369: the desktop fleet still sends `required: false, passed:
        // false` here. A version finding informs; it must never block, and it
        // must not render as a hard failure.
        label: "Gateway Version",
        required: false,
        passed: true,
        severity: CheckSeverity.Warning,
        version: "0.14.10",
        error: "Update available: 0.14.11",
        remediation: "Open the Closedloop Gateway app to update",
        updateAttempted: true,
        updateOutcome: "failed",
        updatePluginIds: ["plugin-code"],
        remediationLinks: [
          {
            label: "Update Closedloop plugins manually",
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

  it("returns undefined when no response is available", () => {
    expect(getRenderableHealthChecks(undefined, null)).toBeUndefined();
  });

  it("resolves the expected MCP URL from the environment default when none is passed", () => {
    // NEXT_PUBLIC_MCP_SERVER_URL is unset in the test environment, so the
    // default parameter resolves to null and no MCP rows are appended.
    const checks = getRenderableHealthChecks({
      checks: [{ id: "git", label: "Git", required: true, passed: true }],
      allRequiredPassed: true,
    });

    expect(checks).toEqual([expect.objectContaining({ label: "Git" })]);
  });

  it("omits the MCP row entirely when a provider's availability is not reported", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          codex: {
            closedloopAvailable: true,
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      },
      null
    );

    expect(checks).toEqual([expect.objectContaining({ label: "Codex MCP" })]);
    expect(checks?.some((check) => check.label === "Claude MCP")).toBe(false);
  });

  it("reports the legacy MCP provider as passed when closedloopAvailable is true", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            closedloopAvailable: true,
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      },
      null
    );

    expect(checks).toEqual([
      {
        id: "claude-mcp",
        label: "Claude MCP",
        required: false,
        passed: true,
      },
    ]);
  });

  it("reports the legacy MCP provider as unavailable with the install remediation when an MCP URL is expected", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            closedloopAvailable: false,
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      },
      "https://example.com/mcp"
    );

    expect(checks).toEqual([
      {
        id: "claude-mcp",
        label: "Claude MCP",
        required: false,
        passed: false,
        error: "Unavailable",
        remediation:
          "Install a user/global MCP server pointing to https://example.com/mcp. Project-local MCP installs are not supported.",
      },
    ]);
  });

  it("omits the version field when an available neutral MCP provider reports no server name", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: true,
            serverName: null,
            matchedUrl: null,
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      },
      null
    );

    expect(checks).toEqual([
      {
        id: "claude-mcp",
        label: "Claude MCP",
        required: false,
        passed: true,
        version: undefined,
      },
    ]);
  });

  it("uses the install remediation when the MCP error reports an unsupported project-local config", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: false,
            serverName: "team-claude",
            matchedUrl: "https://example.com/mcp",
            checkedAt: "2026-04-13T18:41:00.000Z",
            error: "Project-local config unsupported",
          },
        },
      },
      "https://example.com/mcp"
    );

    expect(checks).toEqual([
      expect.objectContaining({
        error: "Project-local config unsupported",
        remediation:
          "Install a user/global MCP server pointing to https://example.com/mcp. Project-local MCP installs are not supported.",
      }),
    ]);
  });

  it("falls back to a generic MCP URL phrase when a matched server has no matchedUrl or expectedMcpUrl", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: false,
            serverName: "team-claude",
            matchedUrl: null,
            checkedAt: "2026-04-13T18:41:00.000Z",
            error: "Discovery timed out",
          },
        },
      },
      null
    );

    expect(checks).toEqual([
      expect.objectContaining({
        remediation:
          "Retry check. team-claude is configured for the expected MCP URL",
      }),
    ]);
  });

  it("points the remediation at the expected MCP URL when no server matched but a URL is expected", () => {
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: false,
            serverName: null,
            matchedUrl: null,
            checkedAt: "2026-04-13T18:41:00.000Z",
            error: "Discovery timed out",
          },
        },
      },
      "https://example.com/mcp"
    );

    expect(checks).toEqual([
      expect.objectContaining({
        remediation:
          "Retry check. If this persists, verify a user/global MCP server pointing to https://example.com/mcp is configured.",
      }),
    ]);
  });

  it("uses a bare retry remediation when a URL matched but no server name resolved and no MCP URL is expected", () => {
    // hasDetectionContext requires expectedMcpUrl || available || serverName ||
    // matchedUrl to be truthy, so a genuinely empty availability (all falsy)
    // returns null instead of a check row (see the preceding test). A truthy
    // matchedUrl with no serverName and no expectedMcpUrl is the only
    // combination that both passes that guard and skips every specific
    // remediation branch, landing on the bare "Retry check." fallback.
    const checks = getRenderableHealthChecks(
      {
        checks: [],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: false,
            serverName: null,
            matchedUrl: "https://matched.example.com/mcp",
            checkedAt: "2026-04-13T18:41:00.000Z",
            error: "Discovery timed out",
          },
        },
      },
      null
    );

    expect(checks).toEqual([
      expect.objectContaining({
        error: "Discovery timed out",
        remediation: "Retry check.",
      }),
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

  /** Extract the staleTime function and invoke it with the given cached data. */
  function getStaleTime(data: unknown): number {
    const options = healthCheckOptions("default", null);
    const staleTimeFn = options.staleTime as (query: {
      state: { data: unknown };
    }) => number;
    return staleTimeFn({ state: { data } });
  }

  it("staleTime returns 0 when cached response has any failing check", () => {
    const result = getStaleTime({
      checks: [
        { id: "git", label: "Git", required: true, passed: true },
        { id: "node", label: "Node", required: true, passed: false },
      ],
      allRequiredPassed: false,
    });

    expect(result).toBe(0);
  });

  it("staleTime returns 24h when all checks pass", () => {
    const result = getStaleTime({
      checks: [
        { id: "git", label: "Git", required: true, passed: true },
        { id: "node", label: "Node", required: true, passed: true },
      ],
      allRequiredPassed: true,
    });

    expect(result).toBe(HEALTH_CHECK_QUERY_STALE_TIME_MS);
  });

  it("staleTime returns 24h when there is no cached data", () => {
    expect(getStaleTime(undefined)).toBe(HEALTH_CHECK_QUERY_STALE_TIME_MS);
  });

  it("fetches with a composed timeout signal while preserving relay headers", async () => {
    const querySignal = new AbortController().signal;
    const timeoutSignal = new AbortController().signal;
    const composedSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);
    const anySpy = vi.spyOn(AbortSignal, "any").mockReturnValue(composedSignal);
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        checks: [],
        allRequiredPassed: true,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const options = healthCheckOptions(
      "cloud-relay:target-1",
      "https://example.com/mcp",
      {
        latestVersion: "9.9.9",
        pluginAutoUpdateEnabled: true,
        relayTargetId: "target-1",
      }
    );

    await runHealthCheckQuery(options, querySignal);

    expect(timeoutSpy).toHaveBeenCalledWith(
      PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS
    );
    expect(anySpy).toHaveBeenCalledWith([querySignal, timeoutSignal]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_RELAY_HEALTH_CHECK_PATH}?expectedMcpUrl=https%3A%2F%2Fexample.com%2Fmcp&latestVersion=9.9.9&pluginAutoUpdate=1`,
      {
        headers: {
          [COMPUTE_TARGET_HEADER]: "target-1",
        },
        signal: composedSignal,
      }
    );
  });

  it("does not inherit production query-client retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = makeQueryClient();
    const options = healthCheckOptions("default", null);

    await expect(queryClient.fetchQuery(options)).rejects.toThrow("offline");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("rejects non-OK health-check responses with the gateway error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: "gateway unavailable",
          },
          { status: 503 }
        )
      )
    );
    const options = healthCheckOptions("default", null);

    await expect(runHealthCheckQuery(options)).rejects.toThrow(
      "Gateway health check failed: gateway unavailable"
    );
  });

  it("rejects malformed successful health-check responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          allRequiredPassed: true,
        })
      )
    );
    const options = healthCheckOptions("default", null);

    await expect(runHealthCheckQuery(options)).rejects.toThrow(
      "Gateway health check returned an invalid response"
    );
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/plugin",
    "http://example.com",
  ])("rejects unsafe remediation link URL %s", async (url) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          checks: [
            {
              id: "plugin-code",
              label: "Symphony Plugin",
              required: true,
              passed: false,
              remediationLinks: [{ label: "Unsafe remediation", url }],
            },
          ],
          allRequiredPassed: false,
        })
      )
    );
    const options = healthCheckOptions("default", null);

    await expect(runHealthCheckQuery(options)).rejects.toThrow(
      "Gateway health check returned an invalid response"
    );
  });

  it("drops unknown plugin outcome values from forward-compatible rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          checks: [
            {
              id: "plugin-code",
              label: "Symphony Plugin",
              required: true,
              passed: false,
              updateOutcome: "future-outcome",
            },
          ],
          allRequiredPassed: false,
        })
      )
    );
    const options = healthCheckOptions("default", null);

    await expect(runHealthCheckQuery(options)).resolves.toEqual({
      checks: [
        {
          id: "plugin-code",
          label: "Symphony Plugin",
          required: true,
          passed: false,
        },
      ],
      allRequiredPassed: false,
    });
  });

  it("classifies a budget abort as a local timeout for direct (non-relay) routing", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        timeoutController.abort();
        return Promise.reject(
          new DOMException("The operation was aborted.", "AbortError")
        );
      })
    );
    const options = healthCheckOptions("default", null);

    await expect(runHealthCheckQuery(options)).rejects.toMatchObject({
      name: "HealthCheckTimeoutError",
      kind: HealthCheckFailureKind.LocalTimeout,
    });
  });

  it("classifies a budget abort as a relay timeout for CloudRelay routing", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        timeoutController.abort();
        return Promise.reject(
          new DOMException("The operation was aborted.", "AbortError")
        );
      })
    );
    const options = healthCheckOptions("cloud-relay:target-1", null);

    await expect(runHealthCheckQuery(options)).rejects.toMatchObject({
      name: "HealthCheckTimeoutError",
      kind: HealthCheckFailureKind.RelayTimeout,
    });
  });

  it("rethrows the original abort error when the caller's own signal aborted too, instead of a timeout verdict", async () => {
    const timeoutController = new AbortController();
    const queryController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const originalError = new DOMException(
      "The operation was aborted.",
      "AbortError"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        timeoutController.abort();
        queryController.abort();
        return Promise.reject(originalError);
      })
    );
    const options = healthCheckOptions("default", null);

    await expect(
      runHealthCheckQuery(options, queryController.signal)
    ).rejects.toBe(originalError);
  });

  it("reuses the caller's already-aborted signal directly instead of composing a new one", async () => {
    const queryController = new AbortController();
    queryController.abort();
    const anySpy = vi.spyOn(AbortSignal, "any");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ checks: [], allRequiredPassed: true })
      );
    vi.stubGlobal("fetch", fetchMock);
    const options = healthCheckOptions("default", null);

    await runHealthCheckQuery(options, queryController.signal);

    expect(anySpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].signal).toBe(queryController.signal);
  });

  it("falls back to the message field when the error body has no error key", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: "target machine offline" }, { status: 502 })
        )
    );
    const options = healthCheckOptions("default", null);

    await expect(runHealthCheckQuery(options)).rejects.toThrow(
      "Gateway health check failed: target machine offline"
    );
  });

  it("falls back to a generic HTTP status message when the error body is not parseable JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 500 }))
    );
    const options = healthCheckOptions("default", null);

    await expect(runHealthCheckQuery(options)).rejects.toThrow(
      "Gateway health check failed with HTTP 500"
    );
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
