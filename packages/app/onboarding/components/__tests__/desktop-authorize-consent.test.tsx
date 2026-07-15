import { encodeDesktopGatewayPublicKey } from "@repo/api/src/types/desktop-authorize-url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { DesktopAuthorizeConsent } from "../desktop-authorize-consent";

// Hoisted so the (hoisted) vi.mock factories below can reference them without
// hitting the temporal dead zone.
const { mockApiClient, redirectMock, flagEnabledMock } = vi.hoisted(() => ({
  mockApiClient: { postRaw: vi.fn() },
  redirectMock: vi.fn(),
  flagEnabledMock: vi.fn((_key: string) => true),
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("../../lib/desktop-authorize-redirect", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/desktop-authorize-redirect")>();
  return { ...actual, redirectToDesktopLoopback: redirectMock };
});

vi.mock("../../../shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => flagEnabledMock(key),
}));

const LOOPBACK = "http://127.0.0.1:49152/cb";
const GATEWAY_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----";
// The desktop base64url-encodes the key on the wire; the parser decodes it back
// to GATEWAY_PUBLIC_KEY (which the mint body assertion still expects).
const GATEWAY_PUBLIC_KEY_PARAM =
  encodeDesktopGatewayPublicKey(GATEWAY_PUBLIC_KEY);

type SearchParams = Record<string, string | string[] | undefined>;

function validSearchParams(overrides: SearchParams = {}): SearchParams {
  return {
    code_challenge: "challenge-abc",
    code_challenge_method: "S256",
    state: "state-xyz",
    redirect_uri: LOOPBACK,
    gateway_id: "gateway-1",
    gateway_public_key: GATEWAY_PUBLIC_KEY_PARAM,
    device_name: "Test MacBook",
    platform: "darwin",
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  flagEnabledMock.mockReturnValue(true);
});

describe("DesktopAuthorizeConsent", () => {
  it("is gated behind the feature flag and renders nothing actionable when off", () => {
    flagEnabledMock.mockReturnValue(false);

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect" })
    ).not.toBeInTheDocument();
    expect(mockApiClient.postRaw).not.toHaveBeenCalled();
  });

  it("renders the consent step for a valid authorize link", () => {
    render(
      <DesktopAuthorizeConsent
        requestedOrgSlug="acme"
        searchParams={validSearchParams()}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("Connect this device?")).toBeInTheDocument();
    expect(screen.getByText("Test MacBook")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("shows an error for an incomplete link and never calls the API", () => {
    render(
      <DesktopAuthorizeConsent
        searchParams={validSearchParams({ state: undefined })}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("Incomplete device link")).toBeInTheDocument();
    expect(mockApiClient.postRaw).not.toHaveBeenCalled();
  });

  it("shows an error for a non-loopback return address", () => {
    render(
      <DesktopAuthorizeConsent
        searchParams={validSearchParams({
          redirect_uri: "https://evil.com/cb",
        })}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("Invalid device link")).toBeInTheDocument();
    expect(mockApiClient.postRaw).not.toHaveBeenCalled();
  });

  it("mints and hands off to the loopback on confirm", async () => {
    mockApiClient.postRaw.mockResolvedValue({
      code: "the-code",
      expiresAt: "2026-07-02T00:01:00.000Z",
    });

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));

    // Binds the resolved user/org server-side; the body carries only the
    // desktop-supplied material + this page's own origin.
    expect(mockApiClient.postRaw).toHaveBeenCalledWith("/desktop/authorize", {
      webAppOrigin: window.location.origin,
      gatewayId: "gateway-1",
      gatewayPublicKeyPem: GATEWAY_PUBLIC_KEY,
      codeChallenge: "challenge-abc",
      codeChallengeMethod: "S256",
      redirectUri: LOOPBACK,
    });

    const target = new URL(redirectMock.mock.calls[0][0] as string);
    expect(target.origin).toBe("http://127.0.0.1:49152");
    expect(target.searchParams.get("code")).toBe("the-code");
    expect(target.searchParams.get("state")).toBe("state-xyz");

    expect(
      await screen.findByText("Returning to desktop…")
    ).toBeInTheDocument();
  });

  it("surfaces a typed error and does not redirect when the mint fails", async () => {
    mockApiClient.postRaw.mockRejectedValue(new ApiError("invalid", 400));

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText("Invalid device request")
    ).toBeInTheDocument();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("does not redirect when the mint returns a malformed 2xx body", async () => {
    // A 2xx with no `code` must surface an error, not hand off to the desktop
    // loopback with `code=undefined`.
    mockApiClient.postRaw.mockResolvedValue({ expiresAt: "2026-07-02" });

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("cancels without minting", () => {
    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Connection cancelled")).toBeInTheDocument();
    expect(mockApiClient.postRaw).not.toHaveBeenCalled();
  });
});
