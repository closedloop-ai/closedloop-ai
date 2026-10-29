/**
 * ISS-9701, end to end through the real path: shared `useApiClient` → the real
 * `QueryCache.onError` boundary in `makeQueryClient` → the auth-rejection store
 * → `WorkspaceAuthGuard`. Only the transport and the Clerk shell hooks are
 * stubbed; the guard, the store, the query client, and `/me` are the production
 * modules.
 *
 * The pair of cases is the whole point of the ticket, and each is the other's
 * control. A token that merely aged out must recover silently — the card must
 * never appear. A session that is genuinely gone must still reach the card,
 * having had a refresh attempted first. A fix that made the retry unconditional,
 * or that suppressed the card, would pass one of these and fail the other.
 */
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import type { AuthTokenOptions } from "@repo/app/shared/auth/auth-adapter";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { clearAuthRejection } from "@repo/app/shared/query/auth-rejection-store";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAuthGuard } from "../workspace-auth-guard";

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: vi.fn(() => Promise.resolve()) }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const TEST_ORIGIN = "https://api.test";
const STALE_TOKEN = "stale-token";
const FRESH_TOKEN = "fresh-token";
const WORKSPACE_TEXT = "workspace content";
const WIDGET_TEXT = "widget loaded";
const WIDGET_ERROR_TEXT = "widget access denied";
const SESSION_EXPIRED_RE = /session expired/i;

type TokenSource = (options?: AuthTokenOptions) => Promise<string | null>;

describe("WorkspaceAuthGuard against a stale token (ISS-9701)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearAuthRejection();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("renders the workspace when a stale token is refreshed and the retry succeeds", async () => {
    const getToken = createTokenSource();
    // Every request carrying the aged-out token is rejected; the same request
    // with a freshly minted one succeeds. This is the production shape of a
    // backgrounded tab or a laptop waking up.
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(
        authorizationOf(init) === `Bearer ${FRESH_TOKEN}`
          ? jsonResponse({ success: true, data: { id: "u1" } })
          : errorResponse(401, "Unauthorized")
      )
    );

    renderGuardedWorkspace(getToken);

    // Positive first: the guarded content and the widget's own read both land.
    expect(await screen.findByText(WORKSPACE_TEXT)).toBeTruthy();
    expect(await screen.findByText(WIDGET_TEXT)).toBeTruthy();
    // Only now is the absence of the card meaningful.
    expect(screen.queryByText(SESSION_EXPIRED_RE)).toBeNull();
    expect(forceRefreshCallCount(getToken)).toBeGreaterThan(0);
  });

  it("still renders the session-expired card when the refresh cannot save the session", async () => {
    const getToken = createTokenSource();
    // The session is genuinely gone: even a freshly minted token is rejected.
    // A FRESH response per call, as a real transport gives — `mockResolvedValue`
    // hands one instance to every attempt, and a `Response` body reads only
    // once, so the retry would be reading a body the first attempt consumed.
    fetchMock.mockImplementation(() =>
      Promise.resolve(errorResponse(401, "Unauthorized"))
    );

    renderGuardedWorkspace(getToken);

    expect(await screen.findByText(SESSION_EXPIRED_RE)).toBeTruthy();
    // The card was earned, not asserted on the first failure: a refresh was
    // attempted and the retried request was rejected too.
    expect(forceRefreshCallCount(getToken)).toBeGreaterThan(0);
    expect(screen.queryByText(WORKSPACE_TEXT)).toBeNull();
  });

  it("leaves a bare 403 to the failing surface's own error state (ISS-5095)", async () => {
    const getToken = createTokenSource();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/me")
          ? jsonResponse({ success: true, data: { id: "u1" } })
          : errorResponse(403, "Forbidden")
      )
    );

    renderGuardedWorkspace(getToken);

    // The widget renders its own denial, inside an otherwise healthy workspace.
    expect(await screen.findByText(WIDGET_ERROR_TEXT)).toBeTruthy();
    expect(screen.getByText(WORKSPACE_TEXT)).toBeTruthy();
    expect(screen.queryByText(SESSION_EXPIRED_RE)).toBeNull();
    // A 403 is not a stale credential, so nothing was refreshed over it.
    expect(forceRefreshCallCount(getToken)).toBe(0);
  });
});

/** A widget read that is NOT the identity probe, with its own error state. */
function Widget() {
  const apiClient = useApiClient();
  const { data, isError } = useQuery({
    queryKey: ["widget"],
    queryFn: () => apiClient.get<{ id: string }>("/teams/t1/repositories"),
  });
  if (isError) {
    return <div>{WIDGET_ERROR_TEXT}</div>;
  }
  return data ? <div>{WIDGET_TEXT}</div> : null;
}

function renderGuardedWorkspace(getToken: TokenSource) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ getToken })}>
        <ApiAdapterProvider adapter={{ resolveApiOrigin: () => TEST_ORIGIN }}>
          <WorkspaceAuthGuard>
            <div>{WORKSPACE_TEXT}</div>
            <Widget />
          </WorkspaceAuthGuard>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

/**
 * A token source with an SDK-shaped cache: the plain read keeps returning the
 * token the server already rejected, and only an explicit refresh mints a new
 * one — so a passing retry can only be the refresh working.
 */
function createTokenSource() {
  return vi
    .fn<TokenSource>()
    .mockImplementation((options) =>
      Promise.resolve(options?.forceRefresh ? FRESH_TOKEN : STALE_TOKEN)
    );
}

function forceRefreshCallCount(getToken: {
  mock: { calls: [AuthTokenOptions?][] };
}): number {
  return getToken.mock.calls.filter(
    ([options]) => options?.forceRefresh === true
  ).length;
}

function authorizationOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function errorResponse(status: number, error: string): Response {
  return jsonResponse({ success: false, error }, { status });
}
