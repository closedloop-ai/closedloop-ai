import {
  DESKTOP_ACCOUNT_CREATED_QUERY_PARAM,
  DESKTOP_AUTHORIZE_RUN_COOKIE,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { createWrapper } from "@repo/app/shared/test-utils";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BareDesktopAuthorizePage from "@/app/(authenticated)/settings/integrations/desktop/authorize/page";
import {
  createDesktopAuthorizeRun,
  encodeDesktopAuthorizeRunCookie,
} from "@/lib/desktop-authorize-run";
import DesktopAuthorizePage from "../page";

/**
 * ISS-11395 AC1-AC3 through the real path: authorize page (server-derived
 * `accountCreated`) → consent → the loopback URL handed to the desktop. Only
 * the request-scoped inputs (the run cookie, Clerk's current user), the mint
 * API, and the final navigation are replaced. Hardcoding the signal either way
 * fails at least one case below.
 */

const { cookieJar, currentUserMock, mockApiClient, redirectMock } = vi.hoisted(
  () => ({
    cookieJar: new Map<string, string>(),
    currentUserMock: vi.fn(),
    mockApiClient: { postRaw: vi.fn() },
    redirectMock: vi.fn(),
  })
);

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
}));

vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  currentUser: currentUserMock,
}));

vi.mock("@/lib/desktop-sign-in-analytics", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/desktop-sign-in-analytics")>();
  return { ...actual, scheduleDesktopSignInAnalyticsReport: vi.fn() };
});

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock(
  "@repo/app/onboarding/lib/desktop-authorize-redirect",
  async (importActual) => {
    const actual =
      await importActual<
        typeof import("@repo/app/onboarding/lib/desktop-authorize-redirect")
      >();
    return { ...actual, redirectToDesktopLoopback: redirectMock };
  }
);

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const ISSUED_AT = NOW - 60_000;
const URL_STATE = "state-xyz";

function authorizeQuery(state = URL_STATE): string {
  return `?${new URLSearchParams({
    code_challenge: "challenge-abc",
    code_challenge_method: "S256",
    state,
    redirect_uri: "http://127.0.0.1:49152/cb",
    gateway_id: "gateway-1",
    gateway_public_key: encodeDesktopGatewayPublicKey(
      "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----"
    ),
    device_name: "Test MacBook",
    platform: "darwin",
  }).toString()}`;
}

function pageSearchParams(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...Object.fromEntries(new URLSearchParams(authorizeQuery())),
    ...extra,
  };
}

function storeRunCookie(state = URL_STATE, userId?: string): void {
  const run = createDesktopAuthorizeRun(authorizeQuery(state), ISSUED_AT);
  const value = run
    ? encodeDesktopAuthorizeRunCookie({ ...run, userId })
    : null;
  if (value === null) {
    throw new Error("fixture run must encode");
  }
  cookieJar.set(DESKTOP_AUTHORIZE_RUN_COOKIE, value);
}

/** Approve on the rendered page and return the loopback URL handed back. */
async function approve(page: ReactNode): Promise<URL> {
  render(page, { wrapper: createWrapper() });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(redirectMock).toHaveBeenCalledTimes(1));
  return new URL(redirectMock.mock.calls[0][0] as string);
}

function orgScopedPage(
  searchParams: Record<string, string>
): Promise<ReactNode> {
  return DesktopAuthorizePage({
    params: Promise.resolve({ orgSlug: "acme" }),
    searchParams: Promise.resolve(searchParams),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  cookieJar.clear();
  mockApiClient.postRaw.mockResolvedValue({
    code: "the-code",
    expiresAt: "2026-09-28T12:01:00.000Z",
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("desktop authorize page — server-derived account_created (ISS-11395)", () => {
  it("reports a creation when the account was created after the run began", async () => {
    storeRunCookie();
    currentUserMock.mockResolvedValue({ createdAt: ISSUED_AT + 1000 });

    const loopback = await approve(await orgScopedPage(pageSearchParams()));

    expect(loopback.searchParams.get(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      "1"
    );
  });

  it("reports a creation for an account created in the same millisecond the run began", async () => {
    storeRunCookie();
    currentUserMock.mockResolvedValue({ createdAt: ISSUED_AT });

    const loopback = await approve(await orgScopedPage(pageSearchParams()));

    expect(loopback.searchParams.get(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      "1"
    );
  });

  it("reports no creation for an account that existed before the run began", async () => {
    storeRunCookie();
    currentUserMock.mockResolvedValue({ createdAt: ISSUED_AT - 1 });

    const loopback = await approve(await orgScopedPage(pageSearchParams()));

    expect(loopback.searchParams.has(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      false
    );
  });

  // AC2: the sign-IN arm never inherits a creation from a composable URL.
  it("ignores an account_created marker on the URL for a pre-existing account", async () => {
    storeRunCookie();
    currentUserMock.mockResolvedValue({ createdAt: ISSUED_AT - 1 });

    const loopback = await approve(
      await orgScopedPage(
        pageSearchParams({ [DESKTOP_ACCOUNT_CREATED_QUERY_PARAM]: "1" })
      )
    );

    expect(loopback.searchParams.has(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      false
    );
  });

  it("reports no creation when the pending run belongs to a different state", async () => {
    storeRunCookie("state-other");
    currentUserMock.mockResolvedValue({ createdAt: ISSUED_AT + 1000 });

    const loopback = await approve(await orgScopedPage(pageSearchParams()));

    expect(loopback.searchParams.has(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      false
    );
  });

  it("reports no creation when the run is bound to a different user", async () => {
    storeRunCookie(URL_STATE, "user_owner");
    currentUserMock.mockResolvedValue({
      id: "user_other",
      createdAt: ISSUED_AT + 1000,
    });

    const loopback = await approve(await orgScopedPage(pageSearchParams()));

    expect(loopback.searchParams.has(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      false
    );
  });

  it("reports a creation when the run is bound to the signed-in user", async () => {
    storeRunCookie(URL_STATE, "user_owner");
    currentUserMock.mockResolvedValue({
      id: "user_owner",
      createdAt: ISSUED_AT + 1000,
    });

    const loopback = await approve(await orgScopedPage(pageSearchParams()));

    expect(loopback.searchParams.get(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      "1"
    );
  });

  it("reports no creation when the signed-in user cannot be loaded", async () => {
    storeRunCookie();
    currentUserMock.mockRejectedValue(new Error("clerk unavailable"));

    const loopback = await approve(await orgScopedPage(pageSearchParams()));

    expect(loopback.searchParams.has(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      false
    );
  });

  it("derives the signal on the bare authorize page too", async () => {
    storeRunCookie();
    currentUserMock.mockResolvedValue({ createdAt: ISSUED_AT + 1000 });

    const loopback = await approve(
      await BareDesktopAuthorizePage({
        searchParams: Promise.resolve(pageSearchParams()),
      })
    );

    expect(loopback.searchParams.get(DESKTOP_ACCOUNT_CREATED_QUERY_PARAM)).toBe(
      "1"
    );
  });
});
