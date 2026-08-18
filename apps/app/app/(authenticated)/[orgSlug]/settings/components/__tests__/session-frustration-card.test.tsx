import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFrustrationCard } from "../session-frustration-card";

const mocks = vi.hoisted(() => ({
  useFrustrationSetting: vi.fn(),
  useSetFrustrationSetting: vi.fn(),
}));

vi.mock("@repo/app/settings/hooks/use-frustration-setting", () => ({
  useFrustrationSetting: mocks.useFrustrationSetting,
  useSetFrustrationSetting: mocks.useSetFrustrationSetting,
}));

const DEFAULT_MUTATE = vi.fn();

const SAVE_ERROR_RE = /couldn't save that change/i;
const LOADING_RE = /loading settings/i;

describe("SessionFrustrationCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFrustrationSetting.mockReturnValue({
      data: { calculateSessionFrustration: false },
      isLoading: false,
      error: null,
    });
    mocks.useSetFrustrationSetting.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
    });
  });

  it("renders nothing for non-admin users", () => {
    const { container } = render(<SessionFrustrationCard isAdmin={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the Frustration Over Time card for admins", () => {
    render(<SessionFrustrationCard isAdmin />);
    expect(screen.getByText("Frustration Over Time")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("reflects the persisted OFF value from the API", () => {
    mocks.useFrustrationSetting.mockReturnValue({
      data: { calculateSessionFrustration: false },
      isLoading: false,
      error: null,
    });
    render(<SessionFrustrationCard isAdmin />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("reflects the persisted ON value from the API", () => {
    mocks.useFrustrationSetting.mockReturnValue({
      data: { calculateSessionFrustration: true },
      isLoading: false,
      error: null,
    });
    render(<SessionFrustrationCard isAdmin />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("fires the mutation with true when the switch is toggled ON", async () => {
    mocks.useFrustrationSetting.mockReturnValue({
      data: { calculateSessionFrustration: false },
      isLoading: false,
      error: null,
    });
    render(<SessionFrustrationCard isAdmin />);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(DEFAULT_MUTATE).toHaveBeenCalledWith(true));
  });

  it("fires the mutation with false when the switch is toggled OFF", async () => {
    mocks.useFrustrationSetting.mockReturnValue({
      data: { calculateSessionFrustration: true },
      isLoading: false,
      error: null,
    });
    render(<SessionFrustrationCard isAdmin />);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(DEFAULT_MUTATE).toHaveBeenCalledWith(false));
  });

  it("disables the switch while the mutation is in flight", () => {
    mocks.useSetFrustrationSetting.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: true,
      isError: false,
    });
    render(<SessionFrustrationCard isAdmin />);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("renders an inline error alert when the mutation fails", () => {
    mocks.useSetFrustrationSetting.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: true,
    });
    render(<SessionFrustrationCard isAdmin />);
    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_ERROR_RE);
  });

  it("renders the loading state while the setting is fetching", () => {
    mocks.useFrustrationSetting.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<SessionFrustrationCard isAdmin />);
    // The switch must not appear while the persisted value is unknown — rendering
    // a confidently-OFF switch would be a lie on an opted-in install.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
  });

  it("keeps the switch hidden in the TanStack paused-offline state (data absent, isLoading false)", () => {
    // A paused fetch (e.g. offline) resolves to `isPending: true` with
    // `isLoading: false` and no data. The persisted value is still unknown, so
    // the switch must stay hidden — falling through to a confidently-OFF switch
    // would misreport an opted-in install as opted-out.
    mocks.useFrustrationSetting.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: false,
      error: null,
    });
    render(<SessionFrustrationCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
  });

  it("renders an error state and no switch when the setting fetch fails", () => {
    mocks.useFrustrationSetting.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("network error"),
    });
    render(<SessionFrustrationCard isAdmin />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("network error")).toBeInTheDocument();
  });
});
