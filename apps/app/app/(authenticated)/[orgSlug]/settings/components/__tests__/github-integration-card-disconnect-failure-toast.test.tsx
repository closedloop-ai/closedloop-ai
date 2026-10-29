import { GitHubInstallationStatus } from "@repo/api/src/types/github";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIntegrationCard } from "../github-integration-card";

const DISCONNECT_BUTTON_NAME = /^disconnect$/i;
const DISCONNECT_DIALOG_NAME = /disconnect github/i;

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
};

const toastCalls: { kind: string; message: string }[] = [];

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

// Only the read hooks are stubbed. `useDisconnectGitHub` stays real so the
// production client's default `mutations.onError` is live.
vi.mock("@repo/app/github/hooks/use-github-integration", async (actual) => ({
  ...(await actual<
    typeof import("@repo/app/github/hooks/use-github-integration")
  >()),
  useConfirmDifferentAccountReset: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useGitHubIntegrationStatus: () => ({
    data: {
      connected: true,
      installation: {
        id: "installation-1",
        installationId: "123",
        accountLogin: "closedloop-ai",
        accountType: "Organization",
        status: GitHubInstallationStatus.Active,
        repositorySelection: "all",
        repositoryCount: 0,
        claimedAt: "2026-05-15T00:00:00.000Z",
        createdAt: "2026-05-15T00:00:00.000Z",
      },
    },
    isError: false,
    isLoading: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
  useGitHubRepositories: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/lib/integration-connect-urls", () => ({
  getGitHubConnectUrl: () => "/api/integrations/github?install=true",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
}));

vi.mock("../public-repositories-section", () => ({
  PublicRepositoriesSection: () => null,
}));

/**
 * The real disconnect hook under the PRODUCTION client factory, so the shared
 * default `mutations.onError` is live and a second, generic toast would be
 * counted (ISS-11741 decision 1).
 */
function renderCard() {
  return render(<GitHubIntegrationCard />, {
    wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
  });
}

async function confirmDisconnect() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: DISCONNECT_BUTTON_NAME })
  );
  const dialog = await screen.findByRole("dialog", {
    name: DISCONNECT_DIALOG_NAME,
  });
  await user.click(
    within(dialog).getByRole("button", { name: DISCONNECT_BUTTON_NAME })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  toastCalls.length = 0;
});

describe("GitHubIntegrationCard disconnect toasts", () => {
  it("toasts a failed disconnect exactly once and still closes the dialog", async () => {
    mockApiClient.delete.mockRejectedValue(new ApiError("boom", 500));
    renderCard();

    await confirmDisconnect();

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: DISCONNECT_DIALOG_NAME })
      ).not.toBeInTheDocument()
    );
    expect(toastCalls).toEqual([
      { kind: "error", message: "Failed to disconnect GitHub" },
    ]);
    expect(mockApiClient.delete).toHaveBeenCalledWith("/integrations/github");
  });

  it("keeps the success toast unchanged", async () => {
    mockApiClient.delete.mockResolvedValue({ disconnected: true });
    renderCard();

    await confirmDisconnect();

    await waitFor(() =>
      expect(toastCalls).toEqual([
        { kind: "success", message: "GitHub disconnected successfully" },
      ])
    );
    expect(
      screen.queryByRole("dialog", { name: DISCONNECT_DIALOG_NAME })
    ).not.toBeInTheDocument();
  });
});
