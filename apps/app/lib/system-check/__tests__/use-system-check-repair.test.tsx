import type {
  CheckResult,
  HealthCheckRepairResponse,
} from "@repo/api/src/types/compute-target";
import {
  HealthCheckRepairAction,
  HealthCheckRepairStepStatus,
} from "@repo/api/src/types/compute-target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRenderableHealthChecks } from "@/lib/engineer/queries/health-check";

const RE_UNSUPPORTED_GATEWAY = /does not support Repair/;

const mockUseFeatureFlagEnabled = vi.hoisted(() => vi.fn());
const mockRepairHealthCheck = vi.hoisted(() => vi.fn());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

vi.mock("@/lib/engineer/queries/health-check-repair", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/engineer/queries/health-check-repair")
  >("@/lib/engineer/queries/health-check-repair");
  return {
    ...actual,
    repairHealthCheck: mockRepairHealthCheck,
  };
});

import { useSystemCheckRepair } from "../use-system-check-repair";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const repairableClaudeCli: CheckResult = {
  id: "claude-cli",
  label: "Claude CLI",
  required: true,
  passed: false,
  error: "Override path does not exist or is not executable",
  repair: {
    repairable: true,
    action: HealthCheckRepairAction.ClearBinaryOverride,
  },
};

const unrepairableGatewayVersion: CheckResult = {
  id: "app-version",
  label: "Gateway Version",
  required: true,
  passed: false,
  error: "Update available",
  repair: {
    repairable: false,
    reason:
      "Updating the Closedloop Gateway app has to happen on that machine.",
  },
};

const repairedResponse: HealthCheckRepairResponse = {
  steps: [
    {
      action: HealthCheckRepairAction.ClearBinaryOverride,
      label: "Clear stale binary path override: Claude CLI",
      status: HealthCheckRepairStepStatus.Succeeded,
      checkIds: ["claude-cli"],
    },
  ],
  result: {
    checks: [{ ...repairableClaudeCli, passed: true, repair: undefined }],
    allRequiredPassed: true,
  },
};

// Stable across renders, exactly as the surfaces supply it (both memoize the
// checks array off the health-check query data).
const defaultChecks: CheckResult[] = [
  repairableClaudeCli,
  unrepairableGatewayVersion,
];

function setup(overrides: Partial<Parameters<typeof useSystemCheckRepair>[0]>) {
  return renderHook(
    () =>
      useSystemCheckRepair({
        checks: defaultChecks,
        expectedMcpUrl: null,
        ...overrides,
      }),
    { wrapper }
  );
}

describe("useSystemCheckRepair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    mockRepairHealthCheck.mockResolvedValue(repairedResponse);
  });

  it("is not offered while the closed-by-default flag is off", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);

    const { result } = setup({});

    // The flag is the only thing withheld — everything it would need is present,
    // so this cannot pass merely because there was nothing to repair.
    expect(result.current.repairableCount).toBe(1);
    expect(result.current.isOffered).toBe(false);
  });

  it("is not offered for a target the user does not own", () => {
    const { result } = setup({ isEligible: false });

    expect(result.current.isOffered).toBe(false);
  });

  it("counts only the rows the gateway said it can repair", () => {
    const { result } = setup({});

    expect(result.current.isOffered).toBe(true);
    expect(result.current.isSupported).toBe(true);
    // The fixture also carries a failing `app-version` row the gateway marked
    // un-repairable; it must not inflate the control's count.
    expect(result.current.repairableCount).toBe(1);
  });

  it("separates repairable REQUIRED rows from repairable optional ones", () => {
    const repairableOptionalMcp: CheckResult = {
      id: "codex-mcp",
      label: "Codex MCP",
      required: false,
      passed: false,
      error: "Closedloop MCP server is not configured",
      repair: {
        repairable: true,
        action: HealthCheckRepairAction.ConfigureMcp,
      },
    };

    // The shape the review called out: the only thing Repair can fix is
    // optional, while the row actually blocking the user is required and beyond
    // Repair. `repairableCount` says "offer the button"; the required count says
    // "do NOT treat the user as unblocked".
    const { result } = setup({
      checks: [unrepairableGatewayVersion, repairableOptionalMcp],
    });

    expect(result.current.repairableCount).toBe(1);
    expect(result.current.repairableRequiredCount).toBe(0);
  });

  it("counts a repairable required row toward the required tally", () => {
    const { result } = setup({});

    expect(result.current.repairableCount).toBe(1);
    expect(result.current.repairableRequiredCount).toBe(1);
  });

  it("hands the automatic re-check back to the surface", async () => {
    const onRepaired = vi.fn();
    const { result } = setup({ onRepaired });

    act(() => {
      result.current.repair();
    });

    await waitFor(() => {
      expect(onRepaired).toHaveBeenCalledTimes(1);
    });
    expect(onRepaired).toHaveBeenCalledWith(repairedResponse.result);
    expect(result.current.steps).toEqual(repairedResponse.steps);
    expect(result.current.errorMessage).toBeNull();
  });

  it("retires the last run's narration once the checks it described are replaced", async () => {
    const { result, rerender } = renderHook(
      ({ checks }: { checks: CheckResult[] }) =>
        useSystemCheckRepair({ checks, expectedMcpUrl: null }),
      {
        wrapper,
        initialProps: {
          checks: [repairableClaudeCli, unrepairableGatewayVersion],
        },
      }
    );

    act(() => {
      result.current.repair();
    });
    await waitFor(() => {
      expect(result.current.steps).toEqual(repairedResponse.steps);
    });

    // The surface adopts the repair's own re-check. It arrives as a deep-equal
    // COPY, never the array the mutation returned: both surfaces route it
    // through `queryClient.setQueryData`, and React Query's structural sharing
    // rebuilds the array on write. Cloning here is what makes this test model
    // production — re-rendering with `repairedResponse.result.checks` by
    // reference passed even while the narration was silently dropped on both
    // real surfaces (ISS-5389 review).
    rerender({ checks: structuredClone(repairedResponse.result.checks) });
    expect(result.current.steps).toEqual(repairedResponse.steps);

    // A later plain Re-check produces a different array; the narration retires
    // rather than describing rows that are no longer on screen.
    rerender({ checks: [{ ...repairableClaudeCli }] });
    expect(result.current.steps).toBeUndefined();
    expect(result.current.joinedInFlight).toBe(false);
  });

  it("keeps the narration when the surface adopts a re-check carrying MCP rows", async () => {
    // The surfaces hand this hook the RENDERABLE checks — gateway rows plus the
    // two synthesized `<provider>-mcp` rows. The repair response carries only
    // the gateway rows, so the "after" identity has to be computed in the same
    // renderable row space; comparing raw against renderable can never match
    // once an MCP row is on screen, and a narration that never matches is
    // silently dropped (ISS-5435, the ISS-5389 failure in a new disguise).
    const expectedMcpUrl = "https://mcp.example.com/mcp";
    const mcpResponse: HealthCheckRepairResponse = {
      ...repairedResponse,
      result: {
        ...repairedResponse.result,
        mcpServers: {
          codex: {
            available: true,
            serverName: "closedloop",
            matchedUrl: expectedMcpUrl,
            checkedAt: "2026-04-12T00:00:00.000Z",
          },
        },
      },
    };
    mockRepairHealthCheck.mockResolvedValue(mcpResponse);

    const { result, rerender } = renderHook(
      ({ checks }: { checks: CheckResult[] }) =>
        useSystemCheckRepair({ checks, expectedMcpUrl }),
      { wrapper, initialProps: { checks: defaultChecks } }
    );

    act(() => {
      result.current.repair();
    });
    await waitFor(() => {
      expect(result.current.steps).toEqual(mcpResponse.steps);
    });

    // What the surface actually adopts: the renderable form of the re-check,
    // which appends a `codex-mcp` row the response's `checks` array never had.
    rerender({
      checks: structuredClone(
        getRenderableHealthChecks(mcpResponse.result, expectedMcpUrl) ?? []
      ),
    });

    expect(result.current.steps).toEqual(mcpResponse.steps);
  });

  it("does not double-run when pressed twice in the same tick", async () => {
    let resolveRepair: (value: HealthCheckRepairResponse) => void = () => {
      // replaced below before any press
    };
    mockRepairHealthCheck.mockImplementation(
      () =>
        new Promise<HealthCheckRepairResponse>((resolve) => {
          resolveRepair = resolve;
        })
    );
    const { result } = setup({});

    act(() => {
      result.current.repair();
    });
    await waitFor(() => {
      expect(result.current.isRepairing).toBe(true);
    });
    act(() => {
      result.current.repair();
    });

    expect(mockRepairHealthCheck).toHaveBeenCalledTimes(1);

    act(() => {
      resolveRepair(repairedResponse);
    });
    await waitFor(() => {
      expect(result.current.isRepairing).toBe(false);
    });
  });

  it("names the failure instead of clearing the panel", async () => {
    mockRepairHealthCheck.mockRejectedValue(
      new Error(
        "This gateway build does not support Repair. Update the Closedloop Gateway app on that machine."
      )
    );
    const { result } = setup({});

    act(() => {
      result.current.repair();
    });

    await waitFor(() => {
      expect(result.current.errorMessage).toMatch(RE_UNSUPPORTED_GATEWAY);
    });
    expect(result.current.steps).toBeUndefined();
  });
});
