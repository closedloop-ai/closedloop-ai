import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSystemCheckEligibility = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();
const mockUseComputeTargets = vi.fn();
const mockUseSearchParams = vi.fn();

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: () => (
    <div data-testid="health-check-dialog">Health Check Dialog</div>
  ),
}));

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
}));

vi.mock("@/lib/system-check/use-system-check-eligibility", () => ({
  useSystemCheckEligibility: () => mockUseSystemCheckEligibility(),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: () => mockUseComputeTargets(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-tasks",
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  useSearchParams: () => mockUseSearchParams(),
}));

import { SystemCheckBootstrap } from "../system-check-bootstrap";

describe("SystemCheckBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });
    mockUseComputeTargets.mockReturnValue({ data: [] });
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
  });

  it("does not render the dialog while eligibility is loading", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: true,
    });

    render(<SystemCheckBootstrap />);

    expect(screen.queryByTestId("health-check-dialog")).toBeNull();
  });

  it("does not render the dialog when system checks are ineligible", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: false,
    });

    render(<SystemCheckBootstrap />);

    expect(screen.queryByTestId("health-check-dialog")).toBeNull();
  });

  it("renders the dialog when the active execution target is eligible", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });

    render(<SystemCheckBootstrap />);

    expect(screen.getByTestId("health-check-dialog")).toBeInTheDocument();
  });

  it("renders the dialog when arriving from onboarding even if not normally eligible", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: false,
    });
    mockUseSearchParams.mockReturnValue(new URLSearchParams("from=onboarding"));

    render(<SystemCheckBootstrap />);

    expect(screen.getByTestId("health-check-dialog")).toBeInTheDocument();
  });

  it("does not render the dialog when still loading even with from=onboarding", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: true,
    });
    mockUseSearchParams.mockReturnValue(new URLSearchParams("from=onboarding"));

    render(<SystemCheckBootstrap />);

    expect(screen.queryByTestId("health-check-dialog")).toBeNull();
  });
});
