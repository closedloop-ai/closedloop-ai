/**
 * ISS-7089 F3, the real-path regression: OnboardingGuard and the checklist
 * share one onboarding-status query, the checklist refetches it with
 * `refetchOnWindowFocus: "always"`, and the guard used to blank its subtree on
 * `isFetching` — so every tab refocus unmounted the authenticated content
 * region until the request settled. This suite drives the REAL hooks against a
 * real QueryClient; only the transport and the shell adapters are stubbed.
 *
 * ISS-7828 adds the terminal-failure half on the same real path: a failed or
 * unreadable status read renders the recoverable card and Retry recovers it,
 * while a session rejection is left to the real `WorkspaceAuthGuard` for as
 * long as it holds one.
 */
import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { ONBOARDING_STATUS_UNAVAILABLE_COPY as COPY } from "@repo/app/onboarding/components/onboarding-status-unavailable";
import { ApiError } from "@repo/app/shared/api/api-error";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { clearAuthRejection } from "@repo/app/shared/query/auth-rejection-store";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { OnboardingGuard } from "../onboarding-guard";
import { useOnboardingChecklist } from "../use-onboarding-checklist";
import { WorkspaceAuthGuard } from "../workspace-auth-guard";

const mockApiClient = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: false }),
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: vi.fn(() => Promise.resolve()) }),
}));

const replaceMock = vi.hoisted(() => vi.fn());

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: replaceMock }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/my-tasks",
}));

const SESSION_EXPIRED_RE = /session expired/i;
/** The session card's Retry, which clears the latch and re-reads `/me` only. */
const SESSION_RETRY_RE = /^retry$/i;

function completedStatus(): OnboardingStatus {
  return { checklist: [], checklistDismissed: false, wizardCompleted: true };
}

/**
 * The production coupling under test: the checklist observer is what asks for
 * the focus refetch, and the guard is what must not react to it.
 */
function ChecklistObserver() {
  useOnboardingChecklist();
  return null;
}

function renderGuarded() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: "org-a",
          userId: "user-a",
        })}
      >
        <OnboardingGuard>
          <ChecklistObserver />
          <div>protected</div>
        </OnboardingGuard>
      </AuthAdapterProvider>
    </QueryClientProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}

describe("OnboardingGuard under a focus-triggered refetch (real hooks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the content region mounted while the refetch is in flight", async () => {
    let releaseRefetch: ((status: OnboardingStatus) => void) | undefined;
    mockApiClient.get
      .mockResolvedValueOnce(completedStatus())
      .mockImplementationOnce(
        () =>
          new Promise<OnboardingStatus>((resolve) => {
            releaseRefetch = resolve;
          })
      );

    renderGuarded();
    expect(await screen.findByText("protected")).toBeInTheDocument();

    // The production trigger: the tab regains focus. TanStack's focusManager
    // listens for `visibilitychange` on window, and the checklist's `"always"`
    // refetches the shared query regardless of staleness.
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));

    // In flight — the exact window that used to blank the app.
    expect(screen.getByText("protected")).toBeInTheDocument();

    await act(async () => {
      releaseRefetch?.(completedStatus());
      // Flush the resolved refetch through the query cache before asserting.
      await Promise.resolve();
    });
    expect(screen.getByText("protected")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

describe("OnboardingGuard on a terminal status failure (real hooks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient.get.mockReset();
  });

  // The 401 case below makes a real QueryClient publish to the module-level
  // auth-rejection latch, which would otherwise outlive this file's cases.
  afterEach(() => {
    clearAuthRejection();
  });

  it.each([
    ["a 503", () => Promise.reject(new ApiError("Service Unavailable", 503))],
    ["a malformed 2xx", () => Promise.resolve({})],
  ])(
    "shows the unavailable card for %s and recovers on Retry",
    async (_label, firstRead) => {
      let releaseRetry: ((status: OnboardingStatus) => void) | undefined;
      mockApiClient.get
        .mockImplementationOnce(firstRead)
        .mockImplementationOnce(
          () =>
            new Promise<OnboardingStatus>((resolve) => {
              releaseRetry = resolve;
            })
        );

      renderGuarded();

      const retry = await screen.findByRole("button", {
        name: COPY.retryLabel,
      });
      expect(
        screen.getByRole("alert", { name: COPY.title })
      ).toBeInTheDocument();
      expect(screen.queryByText("protected")).not.toBeInTheDocument();

      fireEvent.click(retry);

      // Retry's read is in flight: the card stays up and busy rather than the
      // region blanking until the read settles.
      expect(
        await screen.findByRole("button", { name: COPY.retryingLabel })
      ).toHaveAttribute("aria-disabled", "true");
      expect(screen.queryByText("protected")).not.toBeInTheDocument();

      await act(async () => {
        releaseRetry?.(completedStatus());
        await Promise.resolve();
      });

      expect(await screen.findByText("protected")).toBeInTheDocument();
      expect(
        screen.queryByRole("alert", { name: COPY.title })
      ).not.toBeInTheDocument();
      expect(replaceMock).not.toHaveBeenCalled();
    }
  );

  it("leaves a 401 to the shell's session card, never the onboarding card", async () => {
    mockApiClient.get.mockImplementation((path: string) =>
      path === "/onboarding"
        ? Promise.reject(new ApiError("Unauthorized", 401))
        : Promise.resolve({ id: "user-a" })
    );

    renderUnderWorkspaceAuthGuard();

    expect(await screen.findByText(SESSION_EXPIRED_RE)).toBeInTheDocument();
    expect(
      screen.queryByRole("alert", { name: COPY.title })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("protected")).not.toBeInTheDocument();
  });

  // The shell's Retry clears the latch and re-reads `/me` only, so the 401 this
  // guard holds is still an unread status: the region gets the onboarding card,
  // never the workspace, and that card's Retry is what re-reads the status.
  it("shows the onboarding card, not the workspace, once the shell's Retry clears a 401", async () => {
    mockApiClient.get.mockImplementation((path: string) =>
      path === "/onboarding"
        ? Promise.reject(new ApiError("Unauthorized", 401))
        : Promise.resolve({ id: "user-a" })
    );

    renderUnderWorkspaceAuthGuard();
    expect(await screen.findByText(SESSION_EXPIRED_RE)).toBeInTheDocument();

    mockApiClient.get.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/onboarding" ? completedStatus() : { id: "user-a" }
      )
    );
    fireEvent.click(screen.getByRole("button", { name: SESSION_RETRY_RE }));

    expect(
      await screen.findByRole("alert", { name: COPY.title })
    ).toBeInTheDocument();
    expect(screen.queryByText("protected")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: COPY.retryLabel }));

    expect(await screen.findByText("protected")).toBeInTheDocument();
  });
});

/**
 * The shell's real nesting, on the production query client: its
 * `QueryCache.onError` boundary is what latches a session rejection for
 * `WorkspaceAuthGuard` to read.
 */
function renderUnderWorkspaceAuthGuard() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: "org-a",
          userId: "user-a",
        })}
      >
        <OnboardingGuard>
          <WorkspaceAuthGuard>
            <div>protected</div>
          </WorkspaceAuthGuard>
        </OnboardingGuard>
      </AuthAdapterProvider>
    </QueryClientProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}
