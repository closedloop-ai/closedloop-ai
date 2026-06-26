import { GitHubInstallationStatus } from "@repo/api/src/types/github";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIntegrationCard } from "../github-integration-card";

type MockConfirmationDialogProps = {
  open: boolean;
  onConfirm: () => Promise<void> | void;
  title: string;
  confirmLabel?: string;
};

const mockUseDisconnectGitHub = vi.fn();
const mockUseGetGitHubConnectUrl = vi.fn();
const mockUseGitHubIntegrationStatus = vi.fn();
const mockUseGitHubRepositories = vi.fn();
const mockUseConfirmDifferentAccountReset = vi.fn();
const mockRouterReplace = vi.fn();
const mockSearchParams = new URLSearchParams();
const CONNECT_GITHUB_BUTTON_NAME = /connect github/i;
const DISCONNECT_BUTTON_NAME = /^disconnect$/i;
const DISCONNECT_DIALOG_NAME = /disconnect github/i;
const INSTALL_APP_BUTTON_NAME = /install app/i;
const RETRY_BUTTON_NAME = /retry/i;
const mockLocationAssign = vi.fn();
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "location"
);

vi.mock("@repo/app/shared/components/confirmation-dialog", () => ({
  ConfirmationDialog: ({
    open,
    onConfirm,
    title,
    confirmLabel = "Confirm",
  }: MockConfirmationDialogProps) =>
    open ? (
      <div aria-label={title} role="dialog">
        <button
          onClick={async () => {
            await onConfirm();
          }}
          type="button"
        >
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useConfirmDifferentAccountReset: () => mockUseConfirmDifferentAccountReset(),
  useDisconnectGitHub: () => mockUseDisconnectGitHub(),
  useGitHubIntegrationStatus: () => mockUseGitHubIntegrationStatus(),
  useGitHubRepositories: () => mockUseGitHubRepositories(),
}));

vi.mock("@/lib/integration-connect-urls", () => ({
  getGitHubConnectUrl: (...args: unknown[]) =>
    mockUseGetGitHubConnectUrl(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("../public-repositories-section", () => ({
  PublicRepositoriesSection: () => null,
}));

describe("GitHubIntegrationCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        assign: mockLocationAssign,
      },
    });
    mockUseDisconnectGitHub.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    mockUseConfirmDifferentAccountReset.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    mockRouterReplace.mockClear();
    mockUseGetGitHubConnectUrl.mockImplementation((mode = "authorize") =>
      mode === "install"
        ? "/api/integrations/github?install=true"
        : "/api/integrations/github"
    );
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: false },
      isError: false,
      isLoading: false,
      isRefetching: false,
      refetch: vi.fn(),
    });
    mockUseGitHubRepositories.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
  });

  afterEach(() => {
    if (originalLocationDescriptor) {
      Object.defineProperty(globalThis, "location", originalLocationDescriptor);
    }
  });

  it("offers authorize and install flows when settings are disconnected", () => {
    render(<GitHubIntegrationCard />);

    expect(
      screen.getByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: INSTALL_APP_BUTTON_NAME })
    ).toBeEnabled();
    expect(mockUseGetGitHubConnectUrl).toHaveBeenCalledWith("authorize");
    expect(mockUseGetGitHubConnectUrl).toHaveBeenCalledWith("install");
  });

  it("navigates to the authorize flow from Connect GitHub", async () => {
    render(<GitHubIntegrationCard />);

    await userEvent.click(
      screen.getByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME })
    );

    expect(mockLocationAssign).toHaveBeenCalledWith("/api/integrations/github");
  });

  it("navigates to the install flow from Install App", async () => {
    render(<GitHubIntegrationCard />);

    await userEvent.click(
      screen.getByRole("button", { name: INSTALL_APP_BUTTON_NAME })
    );

    expect(mockLocationAssign).toHaveBeenCalledWith(
      "/api/integrations/github?install=true"
    );
  });

  it("offers retry and connect recovery when status loading fails", async () => {
    const refetch = vi.fn();
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
      isRefetching: false,
      refetch,
    });

    render(<GitHubIntegrationCard />);

    expect(
      screen.getByText("Failed to load GitHub integration status")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: INSTALL_APP_BUTTON_NAME })
    ).toBeEnabled();

    await userEvent.click(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME })
    );

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows connected installation status and confirms disconnect", async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseDisconnectGitHub.mockReturnValue({
      isPending: false,
      mutateAsync,
    });
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: {
        connected: true,
        installation: {
          id: "installation-1",
          installationId: "123",
          accountLogin: "closedloop-ai",
          accountType: "Organization",
          status: GitHubInstallationStatus.Active,
          repositorySelection: "all",
          repositoryCount: 1,
          claimedAt: "2026-05-15T00:00:00.000Z",
          createdAt: "2026-05-15T00:00:00.000Z",
        },
      },
      isError: false,
      isLoading: false,
      isRefetching: false,
      refetch: vi.fn(),
    });
    mockUseGitHubRepositories.mockReturnValue({
      data: [
        {
          id: "repo-1",
          fullName: "closedloop-ai/symphony-alpha",
          name: "symphony-alpha",
          owner: "closedloop-ai",
          private: true,
          githubRepoId: "100",
          lastPushedAt: null,
        },
      ],
      isLoading: false,
    });

    render(<GitHubIntegrationCard />);

    expect(screen.getByText("@closedloop-ai")).toBeInTheDocument();
    expect(
      screen.getByText("closedloop-ai/symphony-alpha")
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: DISCONNECT_BUTTON_NAME })
    );
    const dialog = screen.getByRole("dialog", {
      name: DISCONNECT_DIALOG_NAME,
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: DISCONNECT_BUTTON_NAME })
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("shows suspended installation status and opens disconnect confirmation", async () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: {
        connected: true,
        installation: {
          id: "installation-1",
          installationId: "123",
          accountLogin: "closedloop-ai",
          accountType: "Organization",
          status: GitHubInstallationStatus.Suspended,
          repositorySelection: "all",
          repositoryCount: 1,
          claimedAt: "2026-05-15T00:00:00.000Z",
          createdAt: "2026-05-15T00:00:00.000Z",
        },
      },
      isError: false,
      isLoading: false,
      isRefetching: false,
      refetch: vi.fn(),
    });

    render(<GitHubIntegrationCard />);

    expect(screen.getByText("Suspended")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: DISCONNECT_BUTTON_NAME })
    );

    expect(
      screen.getByRole("dialog", { name: DISCONNECT_DIALOG_NAME })
    ).toBeInTheDocument();
  });
});
