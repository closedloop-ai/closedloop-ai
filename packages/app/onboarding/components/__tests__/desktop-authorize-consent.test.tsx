import {
  DESKTOP_AUTHORIZE_RUN_PATHNAME,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { createWrapper } from "@repo/app/shared/test-utils";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { DEFAULT_API_TIMEOUT_MS } from "../../../shared/api/api-timeout";
import { DESKTOP_AUTHORIZE_RUN_CLEAR_TIMEOUT_MS } from "../../lib/desktop-authorize-run-client";
import { DesktopAuthorizeConsent } from "../desktop-authorize-consent";

// Hoisted so the (hoisted) vi.mock factories below can reference them without
// hitting the temporal dead zone.
const { mockApiClient, redirectMock } = vi.hoisted(() => ({
  mockApiClient: { postRaw: vi.fn() },
  redirectMock: vi.fn(),
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// Stubbed to a marker so the assertion below pins the MOUNT rather than the
// panel's internals, which have their own suite.
const HANDBACK_PANEL_TEST_ID = "desktop-handback-panel";
vi.mock("../desktop-handback-panel", () => ({
  DesktopHandbackPanel: () => <div data-testid={HANDBACK_PANEL_TEST_ID} />,
}));

vi.mock("../../lib/desktop-authorize-redirect", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/desktop-authorize-redirect")>();
  return { ...actual, redirectToDesktopLoopback: redirectMock };
});

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

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, status: 204 });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fetch that stays pending until the test settles it. */
function deferredFetch(): {
  resolve: () => void;
  reject: () => void;
} {
  let resolve: () => void = () => undefined;
  let reject: () => void = () => undefined;
  fetchMock.mockReturnValue(
    new Promise((resolveFetch, rejectFetch) => {
      resolve = () => resolveFetch({ ok: true, status: 204 });
      reject = () => rejectFetch(new TypeError("network down"));
    })
  );
  return { resolve: () => resolve(), reject: () => reject() };
}

/** A fetch that never settles on its own, only when its signal aborts. */
function stalledFetch(): void {
  fetchMock.mockImplementation(
    (_input: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        );
      })
  );
}

const CLEAR_RUN_REQUEST = [
  DESKTOP_AUTHORIZE_RUN_PATHNAME,
  {
    method: "DELETE",
    credentials: "same-origin",
    signal: expect.any(AbortSignal),
  },
] as const;

describe("DesktopAuthorizeConsent", () => {
  it("renders the consent step for a valid authorize link with no feature gate", () => {
    // FEA-4133: the web loopback-auth flag graduated to always-on. The consent
    // page renders unconditionally for a valid link — there is no "Not available"
    // dead-end branch to hit.
    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText("Connect this device?")).toBeInTheDocument();
    expect(screen.queryByText("Not available")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
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
    // ISS-10913: no creation was derived for this page, so the hand-off states
    // none — an absent optional field stays absent on the wire.
    expect(target.searchParams.has("account_created")).toBe(false);

    expect(
      await screen.findByText("Returning to desktop…")
    ).toBeInTheDocument();
  });

  it("offers the hand-back panel on the returning-to-desktop card", async () => {
    // ISS-11429. The card promises "handing you back to the desktop app", and
    // the loopback navigation is the only thing that keeps it — when that does
    // not land, the panel is the way out. Without this the panel could be
    // deleted from its ONE production call site with the whole suite green,
    // because its own suite renders it directly.
    mockApiClient.postRaw.mockResolvedValue({
      code: "the-code",
      expiresAt: "2026-07-02T00:01:00.000Z",
    });

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByTestId(HANDBACK_PANEL_TEST_ID)
    ).toBeInTheDocument();
  });

  it("offers the hand-back panel on the terminal error card, which never unloads", async () => {
    // ISS-11429. The success card fires `location.replace` before it renders, so
    // a loopback the browser cannot reach takes that card — and the panel on it —
    // away for a network-error document. This card navigates nowhere, so it is
    // the placement where the way back actually survives to be used, with a
    // desktop still sitting behind the tab waiting for a callback.
    mockApiClient.postRaw.mockRejectedValue(new ApiError("invalid", 400));

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText("Invalid device request")
    ).toBeInTheDocument();
    expect(screen.getByTestId(HANDBACK_PANEL_TEST_ID)).toBeInTheDocument();
  });

  it("offers it on a bad link too, where no mint was ever attempted", () => {
    render(
      <DesktopAuthorizeConsent
        searchParams={validSearchParams({ state: undefined })}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText("Incomplete device link")).toBeInTheDocument();
    expect(screen.getByTestId(HANDBACK_PANEL_TEST_ID)).toBeInTheDocument();
  });

  it("forwards the server-derived account-created signal to the desktop", async () => {
    // ISS-11395: the authorize page derives it from the pending run and the
    // signed-in user; this is the hop that carries it across.
    mockApiClient.postRaw.mockResolvedValue({
      code: "the-code",
      expiresAt: "2026-07-02T00:01:00.000Z",
    });

    render(
      <DesktopAuthorizeConsent
        accountCreated
        searchParams={validSearchParams()}
      />,
      { wrapper: createWrapper() }
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));

    const target = new URL(redirectMock.mock.calls[0][0] as string);
    expect(target.searchParams.get("account_created")).toBe("1");
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

  it("tells the desktop it was cancelled instead of leaving it waiting", async () => {
    // The whole bug: this used to be client-side only, so the tab said "return
    // to the desktop app" while the desktop sat in its awaiting-redirect state
    // until the sign-in timeout fired.
    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));
    const url = new URL(redirectMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("error")).toBe("access_denied");
    // `state` round-trips so the desktop can tell this callback is its own.
    expect(url.searchParams.get("state")).toBe(
      validSearchParams().state as string
    );
    expect(url.searchParams.get("code")).toBeNull();
  });

  it("clears the pending run before handing a minted code back", async () => {
    mockApiClient.postRaw.mockResolvedValue({
      code: "the-code",
      expiresAt: "2026-07-02T00:01:00.000Z",
    });
    const clearRun = deferredFetch();

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(...CLEAR_RUN_REQUEST)
    );
    expect(redirectMock).not.toHaveBeenCalled();

    clearRun.resolve();
    await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));
  });

  it("clears the pending run before handing a cancel back", async () => {
    const clearRun = deferredFetch();

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(...CLEAR_RUN_REQUEST)
    );
    expect(redirectMock).not.toHaveBeenCalled();

    clearRun.resolve();
    await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));
  });

  it("still hands a minted code back when clearing the run fails", async () => {
    mockApiClient.postRaw.mockResolvedValue({
      code: "the-code",
      expiresAt: "2026-07-02T00:01:00.000Z",
    });
    fetchMock.mockRejectedValue(new TypeError("network down"));

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));
    const target = new URL(redirectMock.mock.calls[0][0] as string);
    expect(target.searchParams.get("code")).toBe("the-code");
  });

  it("still hands a cancel back when clearing the run fails", async () => {
    const clearRun = deferredFetch();

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    clearRun.reject();

    await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));
    const url = new URL(redirectMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("error")).toBe("access_denied");
  });

  it("still hands a cancel back when clearing the run stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stalledFetch();

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.advanceTimersByTimeAsync(
      DESKTOP_AUTHORIZE_RUN_CLEAR_TIMEOUT_MS - 1
    );
    expect(redirectMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(redirectMock).toHaveBeenCalledTimes(1);
  });

  // The minted code lives 60 s, so waiting out the API-wide deadline here
  // would hand the desktop a code that has already expired.
  it("hands a minted code back well inside its TTL when clearing the run stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockApiClient.postRaw.mockResolvedValue({
      code: "the-code",
      expiresAt: "2026-07-02T00:01:00.000Z",
    });
    stalledFetch();

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledWith(...CLEAR_RUN_REQUEST);

    await vi.advanceTimersByTimeAsync(
      DESKTOP_AUTHORIZE_RUN_CLEAR_TIMEOUT_MS - 1
    );
    expect(redirectMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(redirectMock).toHaveBeenCalledTimes(1);
    const target = new URL(redirectMock.mock.calls[0][0] as string);
    expect(target.searchParams.get("code")).toBe("the-code");
    expect(DESKTOP_AUTHORIZE_RUN_CLEAR_TIMEOUT_MS).toBeLessThan(
      DEFAULT_API_TIMEOUT_MS
    );
  });

  it.each([400, 403])(
    "clears the pending run when the mint fails with %s",
    async (status) => {
      mockApiClient.postRaw.mockRejectedValue(new ApiError("failed", status));

      render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
        wrapper: createWrapper(),
      });

      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(...CLEAR_RUN_REQUEST)
      );
      expect(redirectMock).not.toHaveBeenCalled();
    }
  );

  // A 401 ends the session, not the run: after signing in again the proxy must
  // still bounce the user back to this consent step.
  it("keeps the pending run when the mint fails with 401", async () => {
    mockApiClient.postRaw.mockRejectedValue(new ApiError("expired", 401));

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Session expired")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the pending run when the mint fails with a retry", async () => {
    mockApiClient.postRaw.mockRejectedValue(new ApiError("boom", 500));

    render(<DesktopAuthorizeConsent searchParams={validSearchParams()} />, {
      wrapper: createWrapper(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByRole("button", { name: "Try again" })
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
