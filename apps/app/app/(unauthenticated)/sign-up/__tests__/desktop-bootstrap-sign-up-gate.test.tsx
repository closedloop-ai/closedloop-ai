import { CLERK_SESSION_TASK_CHOOSE_ORGANIZATION } from "@repo/api/src/types/desktop-bootstrap";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBootstrapBrowserRun } from "@/lib/desktop-bootstrap-run";
import { DesktopBootstrapSignUpGate } from "../desktop-bootstrap-sign-up-gate";

const mocks = vi.hoisted(() => ({
  currentTaskKey: null as string | null,
  postRaw: vi.fn(),
  redirectToDesktopLoopback: vi.fn(),
}));

vi.mock("@repo/auth/client", () => ({
  useSession: () => ({
    isLoaded: true,
    session: mocks.currentTaskKey
      ? { currentTask: { key: mocks.currentTaskKey } }
      : null,
  }),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ postRaw: mocks.postRaw }),
}));

vi.mock(
  "@repo/app/onboarding/lib/desktop-authorize-redirect",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/onboarding/lib/desktop-authorize-redirect")
      >();
    return {
      ...actual,
      redirectToDesktopLoopback: mocks.redirectToDesktopLoopback,
    };
  }
);

const BROWSER_RUN: DesktopBootstrapBrowserRun = {
  bootstrapSupported: true,
  codeChallenge: "challenge-abc",
  codeChallengeMethod: "S256",
  gatewayId: "gateway-1",
  gatewayPublicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----",
  redirectUri: "http://127.0.0.1:49152/cb",
  state: "state-xyz",
};

function renderGate(
  children: ReactNode = <div>Clerk sign-up</div>,
  browserRun: DesktopBootstrapBrowserRun = BROWSER_RUN
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <DesktopBootstrapSignUpGate browserRun={browserRun}>
          {children}
        </DesktopBootstrapSignUpGate>
      </QueryClientProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.currentTaskKey = null;
  mocks.postRaw.mockResolvedValue({
    code: "bootstrap-code",
    expiresAt: "2026-10-04T12:01:00.000Z",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null)))
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DesktopBootstrapSignUpGate", () => {
  it("leaves ordinary sign-up on Clerk", () => {
    renderGate();

    expect(screen.getByText("Clerk sign-up")).toBeInTheDocument();
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });

  it("replaces Clerk's organization task and hands the bootstrap code to Desktop", async () => {
    mocks.currentTaskKey = CLERK_SESSION_TASK_CHOOSE_ORGANIZATION;
    renderGate();

    await waitFor(() =>
      expect(mocks.postRaw).toHaveBeenCalledWith(
        "/desktop/bootstrap-authorize",
        {
          codeChallenge: "challenge-abc",
          codeChallengeMethod: "S256",
          gatewayId: "gateway-1",
          gatewayPublicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----",
          redirectUri: "http://127.0.0.1:49152/cb",
          webAppOrigin: globalThis.location.origin,
        }
      )
    );
    await waitFor(() =>
      expect(mocks.redirectToDesktopLoopback).toHaveBeenCalledWith(
        "http://127.0.0.1:49152/cb?code=bootstrap-code&state=state-xyz&account_created=1&desktop_bootstrap=1"
      )
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/desktop/authorize-run",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(screen.queryByText("Clerk sign-up")).not.toBeInTheDocument();
    expect(mocks.postRaw).toHaveBeenCalledTimes(1);
    expect(mocks.redirectToDesktopLoopback).toHaveBeenCalledTimes(1);
  });

  it("leaves an older Desktop client on Clerk's organization task", () => {
    mocks.currentTaskKey = CLERK_SESSION_TASK_CHOOSE_ORGANIZATION;
    renderGate(<div>Clerk sign-up</div>, {
      ...BROWSER_RUN,
      bootstrapSupported: false,
    });

    expect(screen.getByText("Clerk sign-up")).toBeInTheDocument();
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });

  it("keeps a retryable mint failure on the return surface", async () => {
    mocks.currentTaskKey = CLERK_SESSION_TASK_CHOOSE_ORGANIZATION;
    mocks.postRaw.mockRejectedValueOnce(new Error("offline"));
    renderGate();
    await vi.advanceTimersByTimeAsync(500);

    expect(
      await screen.findByText(
        "We couldn't connect this device. Please try again."
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mocks.postRaw).toHaveBeenCalledTimes(2));
  });
});
