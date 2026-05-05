import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSystemCheckEligibility = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();
const mockUseComputeTargets = vi.fn();
const mockHealthCheckDialog = vi.hoisted(() => vi.fn());

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: (props: { targetKey?: string }) => {
    mockHealthCheckDialog(props);
    return (
      <div data-target-key={props.targetKey} data-testid="health-check-dialog">
        Health Check Dialog
      </div>
    );
  },
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

  it("uses a stable Local Gateway target key while the compute target id hydrates", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });

    const { rerender } = render(<SystemCheckBootstrap />);

    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-target-key",
      "local-gateway"
    );

    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: "target-1",
      source: "auto",
      updatedAt: Date.now(),
    });

    rerender(<SystemCheckBootstrap />);

    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-target-key",
      "local-gateway"
    );
  });
});
