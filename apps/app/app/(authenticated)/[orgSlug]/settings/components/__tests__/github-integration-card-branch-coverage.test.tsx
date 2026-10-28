import type { GitHubInstallationInfo } from "@repo/api/src/types/github";
import {
  GitHubInstallationStatus,
  PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/github";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIntegrationCard } from "../github-integration-card";

type MockConfirmationDialogProps = {
  open: boolean;
  onConfirm: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  title: string;
  confirmLabel?: string;
};

const mockUseDisconnectGitHub = vi.fn();
const mockUseGetGitHubConnectUrl = vi.fn();
const mockUseGitHubIntegrationStatus = vi.fn();
const mockUseGitHubRepositories = vi.fn();
const mockUseConfirmDifferentAccountReset = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn();
const mockRouterReplace = vi.fn();
const mockUseSearchParams = vi.fn();

const DISCONNECTING_TEXT = /disconnecting\.\.\./i;
const CONFIRM_SWITCH_DIALOG_NAME = /confirm github account switch/i;
const CONTINUE_AND_RESET_BUTTON_NAME = /^continue and reset$/i;
const SIMULATE_CLOSED_BUTTON_NAME = /simulate dialog closed/i;
const SIMULATE_STILL_OPEN_BUTTON_NAME = /simulate dialog still open/i;
const RETRY_BUTTON_NAME = /retry/i;
const MANAGE_LINK_NAME = /manage/i;
const AT_HANDLE_TEXT = /^@/;
const PUBLIC_REPOS_MARKER = "public-repositories-section-marker";

const ALL_CONFIRMATION_FIELDS = [
  "priorAccountId",
  "priorAccountLogin",
  "newAccountId",
  "newAccountLogin",
  "newInstallationId",
] as const;

function buildRequiresConfirmationSearchParams(
  omit?: (typeof ALL_CONFIRMATION_FIELDS)[number]
): URLSearchParams {
  const values: Record<(typeof ALL_CONFIRMATION_FIELDS)[number], string> = {
    priorAccountId: "prior-1",
    priorAccountLogin: "prior-login",
    newAccountId: "new-1",
    newAccountLogin: "new-login",
    newInstallationId: "installation-9",
  };
  const params = new URLSearchParams({ github: "requires_confirmation" });
  for (const field of ALL_CONFIRMATION_FIELDS) {
    if (field === omit) {
      continue;
    }
    params.set(field, values[field]);
  }
  return params;
}

function buildInstallation(
  overrides: Partial<GitHubInstallationInfo> = {}
): GitHubInstallationInfo {
  return {
    id: "installation-1",
    installationId: "123",
    accountLogin: "closedloop-ai",
    accountType: "Organization",
    status: GitHubInstallationStatus.Active,
    repositorySelection: "all",
    repositoryCount: 1,
    claimedAt: "2026-05-15T00:00:00.000Z",
    createdAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function mockConnectedStatus(
  installationOverrides: Partial<GitHubInstallationInfo> = {}
) {
  mockUseGitHubIntegrationStatus.mockReturnValue({
    data: {
      connected: true,
      installation: buildInstallation(installationOverrides),
    },
    isError: false,
    isLoading: false,
    isRefetching: false,
    refetch: vi.fn(),
  });
}

vi.mock("@repo/app/shared/components/confirmation-dialog", () => ({
  ConfirmationDialog: ({
    open,
    onConfirm,
    onOpenChange,
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
        <button onClick={() => onOpenChange(false)} type="button">
          Simulate dialog closed
        </button>
        <button onClick={() => onOpenChange(true)} type="button">
          Simulate dialog still open
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
  usePathname: () => "/acme/settings",
  useSearchParams: () => mockUseSearchParams(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
  // NOT routed through `mockUseFeatureFlagEnabled`: that spy is set to a blanket
  // `true` for some cases and its call arguments are asserted, so sharing it
  // would let an unrelated fixture flip the FEA-3570 GitHub mark and would add
  // calls to those assertions. The mark stays on its shipped default here.
  useFeatureFlagEnabledOptional: () => false,
}));

vi.mock("../public-repositories-section", () => ({
  PublicRepositoriesSection: () => <div>{PUBLIC_REPOS_MARKER}</div>,
}));

describe("GitHubIntegrationCard branch coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDisconnectGitHub.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    mockUseConfirmDifferentAccountReset.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
    mockUseGetGitHubConnectUrl.mockImplementation((mode = "authorize") =>
      mode === "install"
        ? "/api/integrations/github?install=true"
        : "/connect/github/link"
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

  it("hides the account handle on the suspended card when accountLogin is blank", () => {
    // pins current behavior: GitHubInstallationInfo.accountLogin is typed as a
    // required string, so a blank value (not undefined) is how the falsy
    // ternary branch is actually reached in production.
    mockConnectedStatus({
      status: GitHubInstallationStatus.Suspended,
      accountLogin: "",
    });

    render(<GitHubIntegrationCard />);

    expect(screen.getByText("Suspended")).toBeInTheDocument();
    expect(screen.queryByText(AT_HANDLE_TEXT)).not.toBeInTheDocument();
  });

  it("shows the disconnecting state on the suspended card's Disconnect button", () => {
    mockUseDisconnectGitHub.mockReturnValue({
      isPending: true,
      mutateAsync: vi.fn(),
    });
    mockConnectedStatus({ status: GitHubInstallationStatus.Suspended });

    render(<GitHubIntegrationCard />);

    expect(
      screen.getByRole("button", { name: DISCONNECTING_TEXT })
    ).toBeDisabled();
  });

  it("shows a loading indicator while the repository list is loading", () => {
    mockConnectedStatus();
    mockUseGitHubRepositories.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    render(<GitHubIntegrationCard />);

    expect(screen.getByText("Loading repositories...")).toBeInTheDocument();
    expect(
      screen.queryByText("No repositories connected")
    ).not.toBeInTheDocument();
  });

  it("shows the empty-repositories message when none are connected", () => {
    mockConnectedStatus();
    mockUseGitHubRepositories.mockReturnValue({ data: [], isLoading: false });

    render(<GitHubIntegrationCard />);

    expect(screen.getByText("No repositories connected")).toBeInTheDocument();
  });

  it("marks private repositories with a lock icon and leaves public repositories unmarked", () => {
    mockConnectedStatus();
    mockUseGitHubRepositories.mockReturnValue({
      data: [
        {
          id: "repo-private",
          fullName: "closedloop-ai/private-repo",
          name: "private-repo",
          owner: "closedloop-ai",
          private: true,
          githubRepoId: "1",
          lastPushedAt: null,
        },
        {
          id: "repo-public",
          fullName: "closedloop-ai/public-repo",
          name: "public-repo",
          owner: "closedloop-ai",
          private: false,
          githubRepoId: "2",
          lastPushedAt: null,
        },
      ],
      isLoading: false,
    });

    render(<GitHubIntegrationCard />);

    const privateItem = screen
      .getByText("closedloop-ai/private-repo")
      .closest("li");
    const publicItem = screen
      .getByText("closedloop-ai/public-repo")
      .closest("li");

    expect(privateItem?.querySelector(".lucide-lock")).not.toBeNull();
    expect(publicItem?.querySelector(".lucide-lock")).toBeNull();
  });

  it("links to the personal GitHub settings page for non-organization accounts", () => {
    mockConnectedStatus({ accountType: "User", installationId: "789" });

    render(<GitHubIntegrationCard />);

    expect(
      screen.getByRole("link", { name: MANAGE_LINK_NAME })
    ).toHaveAttribute("href", "https://github.com/settings/installations/789");
  });

  it("hides the account handle on the connected card when accountLogin is blank", () => {
    mockConnectedStatus({ accountLogin: "" });

    render(<GitHubIntegrationCard />);

    expect(screen.getByText("Connected to GitHub")).toBeInTheDocument();
    expect(screen.queryByText(AT_HANDLE_TEXT)).not.toBeInTheDocument();
  });

  it("shows the disconnecting state on the connected card's Disconnect button", () => {
    mockUseDisconnectGitHub.mockReturnValue({
      isPending: true,
      mutateAsync: vi.fn(),
    });
    mockConnectedStatus();

    render(<GitHubIntegrationCard />);

    expect(
      screen.getByRole("button", { name: DISCONNECTING_TEXT })
    ).toBeDisabled();
  });

  it("renders no interactive controls while the integration status is loading", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: true,
      isRefetching: false,
      refetch: vi.fn(),
    });

    render(<GitHubIntegrationCard />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows a spinner instead of the refresh icon on Retry while refetching", () => {
    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
      isRefetching: true,
      refetch: vi.fn(),
    });

    render(<GitHubIntegrationCard />);

    const retryButton = screen.getByRole("button", { name: RETRY_BUTTON_NAME });
    expect(retryButton).toBeDisabled();
    expect(retryButton.querySelector(".lucide-loader-circle")).not.toBeNull();
    expect(retryButton.querySelector(".lucide-refresh-cw")).toBeNull();
  });

  it("renders the public repositories section when the feature flag is enabled", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(true);

    render(<GitHubIntegrationCard />);

    expect(screen.getByText(PUBLIC_REPOS_MARKER)).toBeInTheDocument();
    expect(mockUseFeatureFlagEnabled).toHaveBeenCalledWith(
      PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY
    );
  });

  // The off arm is the state that actually ships under the closed-by-default UI
  // policy, and it is the arm that dies if the `publicReposEnabled &&` gate is
  // removed from the card.
  it("does not render the public repositories section when the feature flag is disabled", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);

    render(<GitHubIntegrationCard />);

    expect(screen.queryByText(PUBLIC_REPOS_MARKER)).not.toBeInTheDocument();
    expect(mockUseFeatureFlagEnabled).toHaveBeenCalledWith(
      PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY
    );
  });

  it.each(ALL_CONFIRMATION_FIELDS)(
    "does not prompt an account-switch confirmation when %s is missing from the callback params",
    (field) => {
      mockUseSearchParams.mockReturnValue(
        buildRequiresConfirmationSearchParams(field)
      );

      render(<GitHubIntegrationCard />);

      expect(
        screen.queryByRole("dialog", { name: CONFIRM_SWITCH_DIALOG_NAME })
      ).not.toBeInTheDocument();
    }
  );

  // Also exercises handleConfirmReset's `if (!requiresConfirmation) return;`
  // guard on its non-early-return path. The early-return outcome is not
  // separately testable: onConfirm is only reachable through the dialog
  // this same render mounts because requiresConfirmation was truthy, so the
  // closure it captures can never see requiresConfirmation as null.
  it("prompts to confirm the account switch and completes the reset when all callback params are present", async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseConfirmDifferentAccountReset.mockReturnValue({
      isPending: false,
      mutateAsync,
    });
    mockUseSearchParams.mockReturnValue(
      buildRequiresConfirmationSearchParams()
    );

    render(<GitHubIntegrationCard />);

    const dialog = screen.getByRole("dialog", {
      name: CONFIRM_SWITCH_DIALOG_NAME,
    });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: CONTINUE_AND_RESET_BUTTON_NAME,
      })
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith("/settings");
  });

  it("cancels the pending account switch and navigates away when the dialog reports itself closed", async () => {
    mockUseSearchParams.mockReturnValue(
      buildRequiresConfirmationSearchParams()
    );

    render(<GitHubIntegrationCard />);

    const dialog = screen.getByRole("dialog", {
      name: CONFIRM_SWITCH_DIALOG_NAME,
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: SIMULATE_CLOSED_BUTTON_NAME })
    );

    expect(mockRouterReplace).toHaveBeenCalledWith("/settings");
  });

  it("does not cancel the pending account switch when the dialog reports itself still open", async () => {
    mockUseSearchParams.mockReturnValue(
      buildRequiresConfirmationSearchParams()
    );

    render(<GitHubIntegrationCard />);

    const dialog = screen.getByRole("dialog", {
      name: CONFIRM_SWITCH_DIALOG_NAME,
    });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: SIMULATE_STILL_OPEN_BUTTON_NAME,
      })
    );

    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});
