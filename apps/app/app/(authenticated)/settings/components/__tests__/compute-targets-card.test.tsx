import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/hooks/queries/__tests__/test-utils";
import { getHealthCheckTargetKey } from "@/lib/engineer/queries/health-check";
import { queryKeys } from "@/lib/engineer/queries/keys";

const RE_SYSTEM_CHECK = /system check/i;
const RE_RECHECK = /re-check/i;
const RE_LAST_CHECKED = /Last checked /;
const RE_SYSTEM_CHECKS_UNAVAILABLE =
  /System checks are available when the desktop client is connected\./;

const mockUseComputeTargets = vi.fn();
const mockUseDeleteComputeTarget = vi.fn();
const mockUseSystemCheckEligibility = vi.fn();
const mockDeleteMutate = vi.fn();

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  useDeleteComputeTarget: () => mockUseDeleteComputeTarget(),
  useToggleComputeTargetSharing: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/system-check/use-system-check-eligibility", () => ({
  useSystemCheckEligibility: () => mockUseSystemCheckEligibility(),
}));

import { LocalComputeTargetsCard } from "../local-compute-targets-card";

function renderWithClient(queryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <LocalComputeTargetsCard />
    </QueryClientProvider>
  );
}

describe("ComputeTargetsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseComputeTargets.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseDeleteComputeTarget.mockReturnValue({
      isPending: false,
      mutate: mockDeleteMutate,
    });
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(
        Response.json({
          checks: [],
          allRequiredPassed: true,
        })
      ),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders cached system-check results immediately while auto-refreshing in the background", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: "cloud-relay",
      computeTargetId: null,
    });
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, null),
      {
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: false,
            error: "Not found",
            remediation: "Install git",
          },
        ],
        allRequiredPassed: false,
      }
    );

    renderWithClient(queryClient);

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/engineer/health-check");
    expect(screen.getByText("1 failure")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("Install git")).toBeInTheDocument();
  });

  it("shows the last checked timestamp when cached results exist", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: "cloud-relay",
      computeTargetId: null,
    });
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, null),
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
      }
    );

    renderWithClient(queryClient);

    expect(screen.getByText(RE_LAST_CHECKED)).toBeInTheDocument();
  });

  it("renders MCP rows when cached health-check data includes mcpServers", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: "cloud-relay",
      computeTargetId: null,
    });
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, null),
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
            available: true,
            serverName: "team-codex",
            matchedUrl: "https://example.com/mcp",
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      }
    );

    renderWithClient(queryClient);

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("Claude MCP")).toBeInTheDocument();
    expect(screen.getByText("Codex MCP")).toBeInTheDocument();
    expect(screen.getByText("team-claude")).toBeInTheDocument();
  });

  it("auto-runs the first system check when the active target is eligible", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
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
      })
    ) as typeof fetch;

    renderWithClient();

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/engineer/health-check"
      );
    });

    await waitFor(() => {
      expect(screen.getByText("All checks passed")).toBeInTheDocument();
    });
  });

  it("disables manual recheck when the current execution target is ineligible", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: false,
    });

    renderWithClient();

    expect(screen.getByRole("button", { name: RE_RECHECK })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText(RE_SYSTEM_CHECKS_UNAVAILABLE)).toBeInTheDocument();
  });

  it("allows manual recheck after the automatic check has completed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
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
      })
    ) as typeof fetch;

    renderWithClient();

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/engineer/health-check"
      );
    });

    fireEvent.click(screen.getByRole("button", { name: RE_RECHECK }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.getByText("All checks passed")).toBeInTheDocument();
    });
  });
});
