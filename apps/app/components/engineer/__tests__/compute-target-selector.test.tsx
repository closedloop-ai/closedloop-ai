import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const mockUseIsMounted = vi.fn();
const mockUseElectronDetection = vi.fn();
const mockUseComputeTargets = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();
const mockSetManualSelection = vi.fn();

// Mutable flag so individual describe blocks can flip CLOUD_RELAY_ENABLED.
let cloudRelayEnabled = false;

vi.mock("@/hooks/use-is-mounted", () => ({
  useIsMounted: () => mockUseIsMounted(),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: (...args: unknown[]) =>
    mockUseElectronDetection(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
}));

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
  setEngineerRoutingManualSelection: (...args: unknown[]) =>
    mockSetManualSelection(...args),
}));

vi.mock("@/lib/engineer/constants", () => ({
  get CLOUD_RELAY_ENABLED() {
    return cloudRelayEnabled;
  },
  COMPUTE_TARGETS_QUERY_OPTIONS: {
    staleTime: 30_000,
    refetchInterval: 30_000,
  },
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

describe("ComputeTargetSelector (CLOUD_RELAY_ENABLED=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudRelayEnabled = false;
    mockUseIsMounted.mockReturnValue(true);
    mockUseElectronDetection.mockReturnValue(defaultDetection);
    mockUseComputeTargets.mockReturnValue({ data: [], isFetching: false });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: "local_electron",
      computeTargetId: null,
      source: "auto",
    });
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

describe("ComputeTargetSelector (CLOUD_RELAY_ENABLED=true)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudRelayEnabled = true;
    mockUseIsMounted.mockReturnValue(true);
    mockUseElectronDetection.mockReturnValue(defaultDetection);
    mockUseComputeTargets.mockReturnValue({ data: [], isFetching: false });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: "cloud_relay",
      computeTargetId: null,
      source: "auto",
    });
  });

  it("renders the dropdown even when electron is not detected", () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          id: "ct-1",
          machineName: "cloud-box",
          platform: "linux",
          isOnline: true,
        },
      ],
      isFetching: false,
    });

    render(<ComputeTargetSelector />);

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText("Select compute target")).toBeInTheDocument();
  });

  it("renders nothing when no options are available", () => {
    const { container } = render(<ComputeTargetSelector />);

    expect(container.firstChild).toBeNull();
  });

  it("calls setEngineerRoutingManualSelection when a cloud target is selected", async () => {
    const user = userEvent.setup();
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          id: "ct-1",
          machineName: "cloud-box",
          platform: "linux",
          isOnline: true,
        },
      ],
      isFetching: false,
    });

    render(<ComputeTargetSelector />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByText("cloud-box"));

    expect(mockSetManualSelection).toHaveBeenCalledWith("cloud-relay", "ct-1");
  });
});
