import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSystemCheckEligibility = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();

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
});
