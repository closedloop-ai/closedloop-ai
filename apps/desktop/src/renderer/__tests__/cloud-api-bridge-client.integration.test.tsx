import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadPage,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { InvocationEvidenceList } from "@repo/app/agents/components/workspace/invocation-evidence-list";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  DEFAULT_API_TIMEOUT_MS,
  LONG_RUNNING_API_TIMEOUT_MS,
} from "@repo/app/shared/api/api-timeout";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { shouldRetryQuery } from "@repo/app/shared/query/query-client";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudApiFetchErrorReason,
  type CloudApiFetchResult,
  DESKTOP_AUTH_TOKEN_SENTINEL,
} from "../../shared/cloud-api-fetch-contract";
import { DesktopAuthStatus } from "../../shared/contracts";
import { createDesktopCloudApiAdapter } from "../shared-agent-sessions/cloud-api-adapter";
import {
  DesktopAuthProvider,
  useDesktopAuth,
} from "../shared-agent-sessions/desktop-auth-provider";
import type { DesktopAuthState } from "../types/desktop-api";

/**
 * PLN-1138 Phase 4 — the D-G bridge contract, exercised end-to-end through the
 * REAL shared `useApiClient` and the REAL desktop cloud `ApiAdapter`. The
 * adapter's own unit test stops at the synthesized `Response`; every other
 * consumer mocks `useApiClient`. This is the one test that proves the whole
 * chain (auth port → client → adapter → bridge) behaves byte-identically to web:
 * envelope unwrap + `reviveWithDates`, `ApiError` status mapping incl.
 * network-failure → status 0, and the sentinel token never crossing the bridge.
 */

const RE_BRIDGED_INVOCATION = /^bridged-invocation-\d$/;

const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

let cloudApiFetch: ReturnType<typeof vi.fn>;

function setupDesktopApi() {
  cloudApiFetch = vi.fn();
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(AUTHENTICATED)),
      onDesktopAuthStateChanged: vi.fn(() => () => undefined),
      cloudApiFetch,
    },
  });
}

function respondWith(bodyText: string, status = 200): CloudApiFetchResult {
  return {
    kind: "response",
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: [["content-type", "application/json"]],
    bodyText,
  };
}

/**
 * Two real invocation rows, which is the minimum that reaches the Evidence
 * list's comparator at all — `Array.prototype.sort` skips it below two, which is
 * why every one-row fixture in the repo missed the ISS-5771 crash.
 */
function invocationReadPage(): AgentComponentInvocationReadPage {
  const row = (
    suffix: string,
    invokedAt: string
  ): AgentComponentInvocationReadRow => ({
    anchor: {
      eventId: `event-${suffix}`,
      kind: AgentComponentInvocationAnchorKind.Event,
    },
    componentKey: "review",
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    externalInvocationId: `toolu_${suffix}`,
    externalSessionId: `external-session-${suffix}`,
    id: `invocation-${suffix}`,
    invokedAt,
    kind: AgentComponentInvocationKind.Skill,
    normalizedName: `bridged-invocation-${suffix}`,
    relationship: AgentComponentInvocationRelationship.Associated,
    sequence: Number(suffix),
    sessionId: `session-${suffix}`,
    sourceSessionId: `external-session-${suffix}`,
    status: AgentComponentInvocationAttributionStatus.Matched,
  });
  return {
    ambiguousCount: 0,
    hasMore: false,
    // Deliberately OLDEST-FIRST on the wire. The list sorts newest-first, so a
    // comparator that stopped comparing would leave this order untouched and be
    // caught — an already-sorted fixture would pass either way.
    items: [
      row("1", "2026-01-01T03:04:05.000Z"),
      row("2", "2026-01-02T03:04:05.000Z"),
    ],
    total: 2,
    unmatchedCount: 0,
  };
}

function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <DesktopAuthProvider>
      <ApiAdapterProvider
        adapter={createDesktopCloudApiAdapter(window.desktopApi)}
      >
        {children}
      </ApiAdapterProvider>
    </DesktopAuthProvider>
  );
}

async function renderAuthenticatedClient() {
  const { result } = renderHook(
    () => ({ client: useApiClient(), auth: useDesktopAuth() }),
    { wrapper: Wrapper }
  );
  await waitFor(() =>
    expect(result.current.auth.state.status).toBe(
      DesktopAuthStatus.Authenticated
    )
  );
  return result;
}

describe("cloud-API bridge through the shared useApiClient (PLN-1138 D-G)", () => {
  beforeEach(() => {
    setupDesktopApi();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("unwraps the ApiResult envelope and revives ISO dates as Date objects", async () => {
    cloudApiFetch.mockResolvedValue(
      respondWith(
        JSON.stringify({
          success: true,
          data: { id: "s1", createdAt: "2026-01-02T03:04:05.000Z" },
        })
      )
    );
    const result = await renderAuthenticatedClient();

    // The documents detail payload declares `createdAt` a `Date`, so this is a
    // route revival must still fire on. ISS-6208 scoped revival to the endpoint
    // that served the body, and this test previously asked `/agent-sessions/s1`
    // — a route whose payload declares `createdAt` a `string`, so it now
    // (correctly) comes back as one; see the ISS-6208 case below.
    const data = await result.current.client.get<{
      id: string;
      createdAt: Date;
    }>("/documents/s1");

    // Envelope unwrapped: the caller gets `data`, not `{ success, data }`.
    expect(data.id).toBe("s1");
    // reviveWithDates ran during the client's JSON.parse — same as on web.
    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data.createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("scopes revival to the endpoint, exactly as web does (ISS-6208)", async () => {
    // Same bridge, same shared parse authority — so the endpoint-scoped rule
    // must reach desktop too. `/agent-sessions/[id]` declares every `createdAt`
    // it serves (the synced session events) as a `string`, and reviving it here
    // while web leaves it alone would fork the two surfaces' runtime types.
    cloudApiFetch.mockResolvedValue(
      respondWith(
        JSON.stringify({
          success: true,
          data: { id: "s1", createdAt: "2026-01-02T03:04:05.000Z" },
        })
      )
    );
    const result = await renderAuthenticatedClient();

    const data = await result.current.client.get<{
      id: string;
      createdAt: string;
    }>("/agent-sessions/s1");

    expect(typeof data.createdAt).toBe("string");
    expect(data.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("leaves a contract-`string` timestamp as a string, exactly as web does (ISS-5771)", async () => {
    // The bridge crosses `bodyText` as raw text so the shared `useApiClient`
    // stays the single JSON-parse authority for both surfaces. That is only
    // worth anything if desktop observes the SAME revival rule, so assert the
    // negative case here and not just the `createdAt` positive one above:
    // `AgentComponentInvocationReadRow.invokedAt` is declared `string | null`,
    // and reviving it is what crashed the web component detail page.
    cloudApiFetch.mockResolvedValue(
      respondWith(
        JSON.stringify({
          success: true,
          data: invocationReadPage(),
        })
      )
    );
    const result = await renderAuthenticatedClient();

    const page =
      await result.current.client.get<AgentComponentInvocationReadPage>(
        "/agent-components/c1/invocations"
      );

    expect(typeof page.items[0].invokedAt).toBe("string");

    // Then hand that parsed page to the REAL Evidence surface rather than a
    // comparator copied into the test. A local re-implementation can keep
    // passing while `InvocationEvidenceList`'s own sort regresses, which is the
    // whole failure this ticket is about: two rows are the minimum that reaches
    // the comparator at all, because `Array.prototype.sort` skips it below two.
    const navigation = createMemoryNavigation({
      initialPath: "/agents",
      orgSlug: "org-1",
    });
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <InvocationEvidenceList page={page} />
      </NavigationProvider>
    );

    // Rendering at all is half the assertion: before ISS-5771 the revived
    // `Date` made this sort throw and took the surface into its error boundary.
    // The ORDER is the other half — the payload arrives oldest-first and the
    // list renders newest-first, so a comparator that silently stopped comparing
    // fails here rather than passing on a surface that merely mounted.
    const names = screen
      .getAllByText(RE_BRIDGED_INVOCATION)
      .map((node) => node.textContent);
    expect(names).toEqual(["bridged-invocation-2", "bridged-invocation-1"]);
  });

  it("maps a transport (network-error) result to ApiError with status 0", async () => {
    cloudApiFetch.mockResolvedValue({
      kind: "network-error",
      message: "connection refused",
    } satisfies CloudApiFetchResult);
    const result = await renderAuthenticatedClient();

    const error = await result.current.client
      .get("/agent-sessions/s1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  it("maps a main-classified deadline expiry to the client's timeout error", async () => {
    // ISS-5082, end to end. This PR makes main's timer the authoritative
    // deadline on desktop, so if its classification did not cross back, desktop
    // would be structurally incapable of ever producing
    // `API_TIMEOUT_ERROR_CODE` — the ISS-5013 "we stopped waiting" surface
    // would be unreachable here and an expiry would look like a dropped socket.
    cloudApiFetch.mockResolvedValue({
      kind: "network-error",
      message: "The operation was aborted due to timeout",
      reason: CloudApiFetchErrorReason.Timeout,
    } satisfies CloudApiFetchResult);
    const result = await renderAuthenticatedClient();

    const error = await result.current.client
      .get("/agent-sessions/s1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    // The same fact web produces, through the same code — read via the public
    // predicate rather than by comparing the string at a call site.
    expect((error as ApiError).isTimeout()).toBe(true);
    expect((error as ApiError).status).toBe(0);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it("maps an HTTP error status to ApiError carrying that status and message", async () => {
    cloudApiFetch.mockResolvedValue(
      respondWith(
        JSON.stringify({ success: false, error: "You do not have access" }),
        403
      )
    );
    const result = await renderAuthenticatedClient();

    const error = await result.current.client
      .get("/agent-sessions/s1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe("You do not have access");
  });

  it("never marshals the auth sentinel or an Authorization header across the bridge", async () => {
    cloudApiFetch.mockResolvedValue(
      respondWith(JSON.stringify({ success: true, data: {} }))
    );
    const result = await renderAuthenticatedClient();

    await result.current.client.get("/agent-sessions/s1");

    const request = cloudApiFetch.mock.calls[0][0];
    // The sentinel exists only so the client composes an Authorization header;
    // the adapter must strip it — it must appear nowhere in the marshalled request.
    expect(JSON.stringify(request)).not.toContain(DESKTOP_AUTH_TOKEN_SENTINEL);
    const headerKeys = Object.keys(request.headers ?? {}).map((key) =>
      key.toLowerCase()
    );
    expect(headerKeys).not.toContain("authorization");
    expect(request.path).toBe("/agent-sessions/s1");
    expect(request.method ?? "GET").toBe("GET");
    // NB: org scoping is main-owned, not asserted here — the main process
    // strips any renderer-supplied X-Organization-Id and injects its own from
    // getIdentity() (see cloud-api-fetch-ipc.test.ts). A renderer-controlled org
    // header must never be trusted, so this test deliberately makes no claim
    // that it crosses the bridge.
  });

  it("carries a call site's deadline all the way to the bridge request", async () => {
    // ISS-5082, end to end. The two halves are covered separately — the client
    // puts the resolved deadline on the init, the adapter marshals an init that
    // already has one — and both stay green if the chain between them breaks
    // (an init-key filter in `apiRequest`, an `ApiRequestOptions` rename). This
    // asserts the whole chain: what a call site asks for is what main is told.
    cloudApiFetch.mockResolvedValue(
      respondWith(JSON.stringify({ success: true, data: {} }))
    );
    const result = await renderAuthenticatedClient();
    // The client stamps the deadline's REMAINING budget at marshal time, so
    // freeze the clock (after the real-timer auth render above) to pin the
    // marshalled value to the full resolved deadline exactly.
    vi.useFakeTimers();

    await result.current.client.get("/agent-sessions", {
      timeoutMs: LONG_RUNNING_API_TIMEOUT_MS,
    });
    expect(cloudApiFetch.mock.calls[0][0].timeoutMs).toBe(
      LONG_RUNNING_API_TIMEOUT_MS
    );

    // A call site that asks for nothing still pins the bridge to the client's
    // own default rather than leaving main to pick.
    await result.current.client.get("/agent-sessions");
    expect(cloudApiFetch.mock.calls[1][0].timeoutMs).toBe(
      DEFAULT_API_TIMEOUT_MS
    );
  });
});
