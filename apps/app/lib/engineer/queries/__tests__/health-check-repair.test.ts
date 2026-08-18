// @vitest-environment node
import type { CheckResult } from "@repo/api/src/types/compute-target";
import {
  HealthCheckRepairAction,
  HealthCheckRepairStepStatus,
} from "@repo/api/src/types/compute-target";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTE_TARGET_HEADER } from "@/lib/desktop-command-signing/constants";
import {
  buildHealthCheckRepairRequest,
  getRepairableChecks,
  isRepairSupported,
  repairHealthCheck,
} from "@/lib/engineer/queries/health-check-repair";

const RE_UNSUPPORTED_GATEWAY = /does not support Repair/;
const RE_SHARED_TARGET_OWNER = /Teammate owns this one/;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: "claude-cli",
    label: "Claude CLI",
    required: true,
    passed: false,
    ...overrides,
  };
}

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const passingResult = {
  checks: [makeCheck({ passed: true })],
  allRequiredPassed: true,
};

describe("buildHealthCheckRepairRequest", () => {
  it("POSTs to the local gateway path when no relay target is given", () => {
    const request = buildHealthCheckRepairRequest({
      expectedMcpUrl: "https://mcp.test/mcp",
    });

    expect(request.url).toBe(
      "/api/gateway/health-check/repair?expectedMcpUrl=https%3A%2F%2Fmcp.test%2Fmcp"
    );
    expect(request.init?.method).toBe("POST");
    expect(request.init?.headers).toEqual({});
  });

  it("POSTs through the relay, carrying the compute-target header", () => {
    const request = buildHealthCheckRepairRequest({
      expectedMcpUrl: null,
      relayTargetId: "target-1",
      latestVersion: "1.2.3",
    });

    expect(request.url).toBe(
      "/api/gateway-relay/health-check/repair?latestVersion=1.2.3"
    );
    expect(request.init?.headers).toEqual({
      [COMPUTE_TARGET_HEADER]: "target-1",
    });
  });
});

describe("repair eligibility", () => {
  it("counts only failing rows the gateway said it can repair", () => {
    const checks = [
      makeCheck({ id: "claude-cli", repair: { repairable: true } }),
      makeCheck({ id: "git", repair: { repairable: false, reason: "nope" } }),
      makeCheck({ id: "codex", passed: true, repair: { repairable: true } }),
    ];

    expect(getRepairableChecks(checks).map((check) => check.id)).toEqual([
      "claude-cli",
    ]);
  });

  it("treats a gateway that annotates nothing as one that cannot repair", () => {
    // Version skew, older desktop: no `repair` field anywhere.
    const legacyChecks = [makeCheck(), makeCheck({ id: "git" })];

    expect(isRepairSupported(legacyChecks)).toBe(false);
    // Nothing is silently presented as fixable on an older gateway.
    expect(getRepairableChecks(legacyChecks)).toEqual([]);
  });

  it("recognises a gateway that does annotate", () => {
    expect(
      isRepairSupported([makeCheck({ repair: { repairable: false } })])
    ).toBe(true);
  });
});

describe("repairHealthCheck", () => {
  it("returns the steps and the automatically re-checked result", async () => {
    mockFetchJson({
      steps: [
        {
          action: HealthCheckRepairAction.EnablePlugins,
          label: "Enable Closedloop Claude Code plugins",
          status: HealthCheckRepairStepStatus.Succeeded,
          checkIds: ["plugin-code"],
        },
      ],
      result: passingResult,
      joinedInFlight: true,
    });

    const response = await repairHealthCheck({ expectedMcpUrl: null });

    expect(response.steps).toHaveLength(1);
    expect(response.steps[0].action).toBe(
      HealthCheckRepairAction.EnablePlugins
    );
    expect(response.result.allRequiredPassed).toBe(true);
    expect(response.joinedInFlight).toBe(true);
  });

  it("drops a step naming an action this build has never heard of", async () => {
    // Newer desktop, unknown action — the known steps must still render.
    mockFetchJson({
      steps: [
        {
          action: "reboot_the_universe",
          label: "Something new",
          status: HealthCheckRepairStepStatus.Succeeded,
          checkIds: [],
        },
        {
          action: HealthCheckRepairAction.ClearBinaryOverride,
          label: "Clear stale binary path override: Claude CLI",
          status: HealthCheckRepairStepStatus.Succeeded,
          checkIds: ["claude-cli"],
        },
      ],
      result: passingResult,
    });

    const response = await repairHealthCheck({ expectedMcpUrl: null });

    expect(response.steps).toHaveLength(1);
    expect(response.steps[0].action).toBe(
      HealthCheckRepairAction.ClearBinaryOverride
    );
  });

  it("explains a 404 as an out-of-date gateway rather than a raw status", async () => {
    mockFetchJson({}, 404);

    await expect(repairHealthCheck({ expectedMcpUrl: null })).rejects.toThrow(
      RE_UNSUPPORTED_GATEWAY
    );
  });

  it("surfaces the relay's own refusal message", async () => {
    mockFetchJson(
      {
        error:
          "Repair is only available on compute targets you own. Teammate owns this one.",
      },
      403
    );

    await expect(repairHealthCheck({ expectedMcpUrl: null })).rejects.toThrow(
      RE_SHARED_TARGET_OWNER
    );
  });
});
