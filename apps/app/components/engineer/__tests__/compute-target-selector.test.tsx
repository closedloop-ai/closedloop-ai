import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseIsMounted = vi.fn();
const mockUseElectronDetection = vi.fn();

vi.mock("@/hooks/use-is-mounted", () => ({
  useIsMounted: () => mockUseIsMounted(),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: (...args: unknown[]) =>
    mockUseElectronDetection(...args),
}));

import { ComputeTargetSelector } from "../compute-target-selector";

const defaultDetection = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  capabilities: null,
  checkedAt: null,
};

describe("ComputeTargetSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMounted.mockReturnValue(true);
    mockUseElectronDetection.mockReturnValue(defaultDetection);
  });

  it("shows machineName when detected and machineName is set", () => {
    mockUseElectronDetection.mockReturnValue({
      ...defaultDetection,
      detected: true,
      machineName: "my-mac",
    });

    render(<ComputeTargetSelector />);

    expect(screen.getByText("my-mac")).toBeInTheDocument();
  });

  it("shows 'Local' when detected but machineName is null", () => {
    mockUseElectronDetection.mockReturnValue({
      ...defaultDetection,
      detected: true,
      machineName: null,
    });

    render(<ComputeTargetSelector />);

    expect(screen.getByText("Local")).toBeInTheDocument();
  });

  it("renders nothing when not detected", () => {
    mockUseElectronDetection.mockReturnValue({
      ...defaultDetection,
      detected: false,
    });

    const { container } = render(<ComputeTargetSelector />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when useIsMounted returns false", () => {
    mockUseIsMounted.mockReturnValue(false);
    mockUseElectronDetection.mockReturnValue({
      ...defaultDetection,
      detected: true,
      machineName: "my-mac",
    });

    const { container } = render(<ComputeTargetSelector />);

    expect(container.firstChild).toBeNull();
  });

  it("does not render a combobox button", () => {
    mockUseElectronDetection.mockReturnValue({
      ...defaultDetection,
      detected: true,
      machineName: "my-mac",
    });

    render(<ComputeTargetSelector />);

    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
