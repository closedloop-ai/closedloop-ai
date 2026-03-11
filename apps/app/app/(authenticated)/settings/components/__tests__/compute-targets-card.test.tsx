import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/hooks/queries/__tests__/test-utils";
import { queryKeys } from "@/lib/engineer/queries/keys";

const RE_SYSTEM_CHECK = /system check/i;
const RE_RECHECK = /re-check/i;
const RE_LAST_CHECKED = /Last checked /;
const RE_SYSTEM_CHECKS_UNAVAILABLE =
  /System checks are available when an online relay target is selected or when the desktop client is connected\./;

const mockUseComputeTargets = vi.fn();
const mockUseDeleteComputeTarget = vi.fn();
const mockUseSystemCheckEligibility = vi.fn();
const mockDeleteMutate = vi.fn();

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  useDeleteComputeTarget: () => mockUseDeleteComputeTarget(),
}));

vi.mock("@/lib/system-check/use-system-check-eligibility", () => ({
  useSystemCheckEligibility: () => mockUseSystemCheckEligibility(),
}));

import { ComputeTargetsCard } from "../compute-targets-card";

function renderWithClient(queryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ComputeTargetsCard />
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
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads cached system-check results without auto-fetching", () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.healthCheck(), {
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
    });

    renderWithClient(queryClient);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.getByText("1 failure")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("Install git")).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows the last checked timestamp when cached results exist", () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.healthCheck(), {
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
    });

    renderWithClient(queryClient);

    expect(screen.getByText(RE_LAST_CHECKED)).toBeInTheDocument();
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

  it("allows manual recheck through the disabled query observer", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: RE_RECHECK }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/engineer/health-check"
      );
    });

    await waitFor(() => {
      expect(screen.getByText("All checks passed")).toBeInTheDocument();
    });
  });
});
