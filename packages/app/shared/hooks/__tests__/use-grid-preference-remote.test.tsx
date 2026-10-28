import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  GRID_PREFERENCE_ROUTE,
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceReadStatus,
  GridPreferenceScopeKey,
  GridPreferenceWriteStatus,
} from "@repo/api/src/types/grid-preferences";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAdapter } from "../../api/api-adapter";
import { ApiAdapterProvider } from "../../api/provider";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY } from "../../lib/feature-flags";
import {
  GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS,
  GRID_PREFERENCE_WRITE_FAILED_MESSAGE,
  useGridPreferenceRemote,
} from "../use-grid-preference-remote";

const STORAGE_KEY = "sessions:saved-view:web:u:user-1";
const DEFAULT_ORG_ID = "org-1";
const LOCAL_VIEW = JSON.stringify({ sortDir: "desc", sortKey: "date" });
const SERVER_VIEW = { sortDir: "asc", sortKey: "name" };

const toastCalls = vi.hoisted(() => ({
  error: [] as string[],
  info: [] as string[],
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.error.push(message),
    info: (message: string) => toastCalls.info.push(message),
  },
}));

type Call = { method: string; path: string; body: unknown };

/**
 * Drive the REAL `useApiClientOptional` through an injected transport, so every
 * case exercises the production request path — route, query string, envelope
 * reading, and the `ApiError` a 409 raises — rather than a mocked client that
 * would prove nothing about either.
 */
function createTransport(
  respond: (call: Call) => { status: number; body: unknown }
) {
  const calls: Call[] = [];
  const adapter: ApiAdapter = {
    fetch: (input, init) => {
      const url = new URL(String(input));
      const call: Call = {
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
      };
      calls.push(call);
      const { status, body } = respond(call);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status,
        })
      );
    },
    resolveApiOrigin: () => "https://api.test",
  };
  return { adapter, calls };
}

function foundBody(value: Record<string, unknown>, revision: number) {
  return {
    data: {
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      preference: {
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
        createdAt: "2026-09-11T00:00:00.000Z",
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        revision,
        scopeKey: GridPreferenceScopeKey.Default,
        updatedAt: "2026-09-11T00:00:00.000Z",
        value,
      },
      status: GridPreferenceReadStatus.Found,
    },
    success: true,
  };
}

function missingBody() {
  return {
    data: {
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      selector: {
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
      },
      status: GridPreferenceReadStatus.Missing,
    },
    success: true,
  };
}

function storedBody(value: Record<string, unknown>, revision: number) {
  const found = foundBody(value, revision);
  return {
    data: {
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      preference: found.data.preference,
      status: GridPreferenceWriteStatus.Stored,
    },
    success: true,
  };
}

/**
 * A transport whose GET is held open until the test releases it, so a case can
 * drive the window between the surface mounting and the account's own copy
 * arriving — the window in which a write has no revision to compare against.
 */
function createHeldReadTransport(postBody: unknown) {
  const calls: Call[] = [];
  let release: ((body: unknown) => void) | null = null;
  const adapter: ApiAdapter = {
    fetch: (input, init) => {
      const method = init?.method ?? "GET";
      const url = new URL(String(input));
      calls.push({
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
        path: `${url.pathname}${url.search}`,
      });
      if (method === "GET") {
        return new Promise<Response>((resolve) => {
          release = (body) => resolve(jsonResponse(200, body));
        });
      }
      return Promise.resolve(jsonResponse(200, postBody));
    },
    resolveApiOrigin: () => "https://api.test",
  };
  return {
    adapter,
    calls,
    releaseRead: (body: unknown) => release?.(body),
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/**
 * Mount the hook under adapters the test can MOVE mid-mount. The wrapper reads
 * a mutable binding rather than a prop, the same shape `renderHookWithAuth` uses
 * in the sibling suite: RTL fixes `wrapper` at render time, so a closed gate or
 * a changed account has to reach the providers through a closure.
 */
function renderMovableRemote(
  adapter: ApiAdapter,
  identity: { enabled: boolean; orgId?: string; userId: string | null }
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiAdapterProvider adapter={adapter}>
      <AuthAdapterProvider
        // Rebuilt on every render, exactly as the desktop shell rebuilds its
        // adapter whenever the main process re-pushes the auth state: a fresh
        // `getToken` closure, hence a fresh API client, for an unchanged account.
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: identity.orgId ?? DEFAULT_ORG_ID,
          userId: identity.userId,
        })}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: identity.enabled
              ? [GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY]
              : [],
          })}
        >
          {children}
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </ApiAdapterProvider>
  );
  return renderHook(
    () =>
      useGridPreferenceRemote({
        gridKey: GridPreferenceGridKey.Sessions,
        scopeKey: GridPreferenceScopeKey.Default,
        storageKey: STORAGE_KEY,
      }),
    { wrapper }
  );
}

function renderRemote(
  adapter: ApiAdapter,
  options?: { enabled?: boolean; userId?: string | null }
) {
  const enabled = options?.enabled ?? true;
  const userId = options?.userId === undefined ? "user-1" : options.userId;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiAdapterProvider adapter={adapter}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: true, userId })}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: enabled
              ? [GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY]
              : [],
          })}
        >
          {children}
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </ApiAdapterProvider>
  );
  return renderHook(
    () =>
      useGridPreferenceRemote({
        gridKey: GridPreferenceGridKey.Sessions,
        scopeKey: GridPreferenceScopeKey.Default,
        storageKey: STORAGE_KEY,
      }),
    { wrapper }
  );
}

function writes(calls: Call[]) {
  return calls.filter((call) => call.method === "POST");
}

beforeEach(() => {
  localStorage.setItem(STORAGE_KEY, LOCAL_VIEW);
});

afterEach(() => {
  localStorage.clear();
  toastCalls.error.length = 0;
  toastCalls.info.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hydration and import", () => {
  it("adopts the account's stored layout and imports nothing", async () => {
    const { adapter, calls } = createTransport(() => ({
      body: foundBody(SERVER_VIEW, 3),
      status: 200,
    }));

    const { result } = renderRemote(adapter);

    await waitFor(() =>
      expect(result.current.inbound?.serialized).toBe(
        JSON.stringify(SERVER_VIEW)
      )
    );
    expect(writes(calls)).toHaveLength(0);
    // Daveth 2026-09-11: local data is kept, never deleted by adoption.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(LOCAL_VIEW);
  });

  it("sends the full selector as the read query, never a partial one", async () => {
    const { adapter, calls } = createTransport(() => ({
      body: missingBody(),
      status: 200,
    }));

    renderRemote(adapter);

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const query = new URLSearchParams(calls[0].path.split("?")[1]);
    expect(Object.fromEntries(query)).toEqual({
      gridKey: GridPreferenceGridKey.Sessions,
      preferenceKind: GridPreferenceKind.ViewState,
      scopeKey: GridPreferenceScopeKey.Default,
    });
    expect(calls[0].path.startsWith(GRID_PREFERENCE_ROUTE)).toBe(true);
  });

  it("imports the local layout whole when the account holds none", async () => {
    const { adapter, calls } = createTransport((call) => ({
      body:
        call.method === "GET"
          ? missingBody()
          : storedBody(JSON.parse(LOCAL_VIEW), 1),
      status: 200,
    }));

    renderRemote(adapter);

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({
      gridKey: GridPreferenceGridKey.Sessions,
      preferenceKind: GridPreferenceKind.ViewState,
      scopeKey: GridPreferenceScopeKey.Default,
      value: JSON.parse(LOCAL_VIEW),
    });
    // No `expectedRevision`: there is no row to compare against yet.
    expect(writes(calls)[0].body).not.toHaveProperty("expectedRevision");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(LOCAL_VIEW);
  });

  /**
   * The idempotency proof AT THE HOOK: mount, import, then mount again against
   * the row the first mount produced. The second mount issues no write and the
   * server value is unchanged.
   *
   * COUNTERFACTUAL: import on local presence rather than on the remote being
   * `missing` (drop the `found` branch of `planGridPreferenceAdoption`) and the
   * second mount writes, so `writes(calls)` is 2 and this fails.
   */
  it("is idempotent across two mounts: the second writes nothing", async () => {
    let stored: Record<string, unknown> | null = null;
    const { adapter, calls } = createTransport((call) => {
      if (call.method === "GET") {
        return {
          body: stored === null ? missingBody() : foundBody(stored, 1),
          status: 200,
        };
      }
      stored = (call.body as { value: Record<string, unknown> }).value;
      return { body: storedBody(stored, 1), status: 200 };
    });

    const first = renderRemote(adapter);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    first.unmount();
    const afterImport = stored;

    renderRemote(adapter);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(2)
    );

    expect(writes(calls)).toHaveLength(1);
    expect(stored).toEqual(afterImport);
  });

  it("leaves the row alone when the read never lands", async () => {
    const { adapter, calls } = createTransport(() => ({
      body: { error: "nope", success: false },
      status: 500,
    }));

    const { result } = renderRemote(adapter);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(writes(calls)).toHaveLength(0);
    expect(result.current.inbound).toBeNull();
  });

  it("treats a response the contract does not describe as no answer", async () => {
    const { adapter, calls } = createTransport(() => ({
      body: { data: { status: "sideways" }, success: true },
      status: 200,
    }));

    const { result } = renderRemote(adapter);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(writes(calls)).toHaveLength(0);
    expect(result.current.inbound).toBeNull();
  });

  it("skips the import when the local bytes are malformed", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { adapter, calls } = createTransport(() => ({
      body: missingBody(),
      status: 200,
    }));

    renderRemote(adapter);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(writes(calls)).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("{not json");
  });
});

describe("the closed gate", () => {
  /**
   * COUNTERFACTUAL: delete the flag read in `useGridPreferenceRemote` (or
   * default it open) and both assertions fail — a closed-by-default surface
   * would reach the network and import on its own.
   */
  it("issues no request and publishes nothing while the flag is closed", async () => {
    const { adapter, calls } = createTransport(() => ({
      body: missingBody(),
      status: 200,
    }));

    const { result } = renderRemote(adapter, { enabled: false });
    act(() => result.current.publish(JSON.stringify({ sortKey: "name" })));
    await Promise.resolve();

    expect(calls).toHaveLength(0);
    expect(result.current.inbound).toBeNull();
  });

  it("issues no request for a surface with no signed-in identity", async () => {
    const { adapter, calls } = createTransport(() => ({
      body: missingBody(),
      status: 200,
    }));

    renderRemote(adapter, { userId: null });
    await Promise.resolve();

    expect(calls).toHaveLength(0);
  });
});

describe("debounced publishing", () => {
  it("collapses a burst into one write carrying the last layout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport((call) => ({
      body:
        call.method === "GET"
          ? foundBody(SERVER_VIEW, 3)
          : storedBody({ width: 3 }, 4),
      status: 200,
    }));

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => {
      result.current.publish(JSON.stringify({ width: 1 }));
      result.current.publish(JSON.stringify({ width: 2 }));
      result.current.publish(JSON.stringify({ width: 3 }));
    });
    expect(writes(calls)).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toMatchObject({
      expectedRevision: 3,
      value: { width: 3 },
    });
  });

  it("does not write back the layout it just adopted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport(() => ({
      body: foundBody(SERVER_VIEW, 3),
      status: 200,
    }));

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    // The consumer re-serializes with its own key order; the same layout must
    // still read as "already stored".
    act(() =>
      result.current.publish(
        JSON.stringify({ sortKey: "name", sortDir: "asc" })
      )
    );
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(writes(calls)).toHaveLength(0);
  });
  /**
   * The debounce window is also the window in which a change exists on this
   * device only, so unmounting inside it must SEND, not drop — otherwise an
   * in-app navigation loses the reader's last resize and the next mount's
   * adopt-the-server rule silently replaces it.
   *
   * COUNTERFACTUAL: make the effect cleanup `clearPendingTimer(sync)` instead of
   * `flushSync(sync)` — cancel the armed write without sending it, which is how
   * it was first written — and no POST is ever issued, so this fails.
   */
  it("sends a pending change when the surface unmounts inside the debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport((call) => ({
      body:
        call.method === "GET"
          ? foundBody(SERVER_VIEW, 3)
          : storedBody({ width: 9 }, 4),
      status: 200,
    }));

    const { result, unmount } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify({ width: 9 })));
    expect(writes(calls)).toHaveLength(0);
    unmount();

    await vi.waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toMatchObject({ value: { width: 9 } });
  });
});

describe("the write lifecycle", () => {
  /**
   * The restored local view reaches `publish` on mount, before the account's own
   * copy has arrived. A write then has no revision, so it is not a
   * compare-and-swap at all — it unconditionally replaces whatever the account
   * holds, decided by a screen that has not seen it.
   *
   * COUNTERFACTUAL: drop the `adopted` gate in `flushSync` (how it was first
   * written) and the debounced POST goes out while the read is still open, so
   * the first assertion sees 1 write, carrying no `expectedRevision`.
   */
  it("holds a publish made before the account's copy has been read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const held = createHeldReadTransport(storedBody({ sortKey: "local" }, 4));

    const { result } = renderMovableRemote(held.adapter, {
      enabled: true,
      userId: "user-1",
    });
    await vi.waitFor(() => expect(held.calls).toHaveLength(1));

    act(() => result.current.publish(JSON.stringify({ sortKey: "local" })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    expect(writes(held.calls)).toHaveLength(0);

    await act(async () => {
      held.releaseRead(foundBody(SERVER_VIEW, 3));
      await Promise.resolve();
    });

    // Adoption is authoritative: the held bytes described the layout this
    // delivery just replaced on screen, so they are dropped, not sent.
    await vi.waitFor(() =>
      expect(result.current.inbound?.serialized).toBe(
        JSON.stringify(SERVER_VIEW)
      )
    );
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });
    expect(writes(held.calls)).toHaveLength(0);
  });

  /**
   * Two edits, the second made while the first write is still out.
   *
   * COUNTERFACTUAL: drop the `inFlight` lock (how it was first written) and the
   * second POST leaves immediately — so the mid-test assertion sees 2 writes,
   * and the second carries `expectedRevision: 3`, the token the first write is
   * in the middle of replacing, which the server answers with a 409 the reader
   * did not cause.
   */
  it("serializes two writes, the second carrying the revision the first returned", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let releaseFirstWrite: (() => void) | null = null;
    let posts = 0;
    const calls: Call[] = [];
    const adapter: ApiAdapter = {
      fetch: (input, init) => {
        const method = init?.method ?? "GET";
        const url = new URL(String(input));
        calls.push({
          body:
            init?.body === undefined
              ? undefined
              : JSON.parse(String(init.body)),
          method,
          path: `${url.pathname}${url.search}`,
        });
        if (method === "GET") {
          return Promise.resolve(jsonResponse(200, foundBody(SERVER_VIEW, 3)));
        }
        posts += 1;
        if (posts === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstWrite = () =>
              resolve(jsonResponse(200, storedBody({ width: 1 }, 7)));
          });
        }
        return Promise.resolve(jsonResponse(200, storedBody({ width: 2 }, 8)));
      },
      resolveApiOrigin: () => "https://api.test",
    };

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify({ width: 1 })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(writes(calls)).toHaveLength(1));

    act(() => result.current.publish(JSON.stringify({ width: 2 })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(writes(calls)).toHaveLength(1);

    await act(async () => {
      releaseFirstWrite?.();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[0].body).toMatchObject({
      expectedRevision: 3,
      value: { width: 1 },
    });
    expect(writes(calls)[1].body).toMatchObject({
      expectedRevision: 7,
      value: { width: 2 },
    });
    expect(toastCalls.error).toHaveLength(0);
    expect(toastCalls.info).toHaveLength(0);
  });

  /**
   * The effect cleanup runs for two different reasons and only one of them is an
   * unmount. Closing the gate replaces the effect too, and flushing there posts
   * a layout for a feature the reader no longer has switched on.
   *
   * COUNTERFACTUAL: make the cleanup flush unconditionally (how it was first
   * written) and the pending bytes go out after the gate closed, so this sees 1
   * write.
   */
  it("drops a pending write when the gate closes instead of posting it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const identity = { enabled: true, userId: "user-1" as string | null };
    const { adapter, calls } = createTransport((call) => ({
      body:
        call.method === "GET"
          ? foundBody(SERVER_VIEW, 3)
          : storedBody({ width: 1 }, 4),
      status: 200,
    }));

    const { result, rerender } = renderMovableRemote(adapter, identity);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify({ width: 1 })));
    identity.enabled = false;
    act(() => rerender());
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    expect(writes(calls)).toHaveLength(0);
  });

  /**
   * The same cleanup, reached by an account switch: the bytes belong to the
   * account that is going away, and the session that replaces it is a different
   * reader's.
   *
   * COUNTERFACTUAL: as above — an unconditional flush posts the previous
   * account's layout through the new one.
   */
  it("drops a pending write when the signed-in account changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const identity = { enabled: true, userId: "user-1" as string | null };
    const { adapter, calls } = createTransport((call) => ({
      body:
        call.method === "GET"
          ? foundBody(SERVER_VIEW, 3)
          : storedBody({ width: 1 }, 4),
      status: 200,
    }));

    const { result, rerender } = renderMovableRemote(adapter, identity);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify({ width: 1 })));
    identity.userId = "user-2";
    act(() => rerender());
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    // The new account re-reads its own row, and nothing the old one held is
    // written through it.
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "GET")).toHaveLength(2)
    );
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("what counts as a different row", () => {
  /**
   * A desktop access-token refresh re-pushes the auth state, so the provider
   * rebuilds its adapter and `useApiClientOptional` hands out a NEW client
   * object for the same account, organization, scope and grid. That is the same
   * row, and the refresh is lazy — the bridged request most likely to trigger it
   * is this hook's own POST.
   *
   * COUNTERFACTUAL: put `client` back in the effect deps and in the `replaced`
   * comparison (how it was first written) and the rerender retires the row: the
   * buffered write is discarded so `writes` is 0, and a second GET re-delivers
   * the layout the reader has just changed.
   */
  it("keeps the row through a client rebuilt by a token refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const identity = { enabled: true, userId: "user-1" as string | null };
    const { adapter, calls } = createTransport((call) => ({
      body:
        call.method === "GET"
          ? foundBody(SERVER_VIEW, 3)
          : storedBody({ width: 1 }, 4),
      status: 200,
    }));

    const { result, rerender } = renderMovableRemote(adapter, identity);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify({ width: 1 })));
    act(() => rerender());
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toMatchObject({
      expectedRevision: 3,
      value: { width: 1 },
    });
    // One read for the life of the row: the refresh did not re-adopt over the
    // reader's own edit.
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  /**
   * The account row is unique on `(organizationId, userId, gridKey,
   * preferenceKind, scopeKey)` and the route derives the organization from the
   * session (ISS-9448), so an organization switch IS a different row — even
   * though the selector, the user and the `localStorage` key are all unchanged,
   * the local key carrying no organization at all.
   *
   * COUNTERFACTUAL: drop `orgId` from the effect deps and the `replaced`
   * comparison and the switch keeps the previous organization's sync state, so
   * no second read is issued and the buffered bytes are posted through the new
   * organization's session carrying the old organization's revision.
   */
  it("treats an organization switch as a different row", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const identity = {
      enabled: true,
      orgId: "org-1",
      userId: "user-1" as string | null,
    };
    const { adapter, calls } = createTransport((call) => ({
      body:
        call.method === "GET"
          ? foundBody(SERVER_VIEW, 3)
          : storedBody({ width: 1 }, 4),
      status: 200,
    }));

    const { result, rerender } = renderMovableRemote(adapter, identity);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify({ width: 1 })));
    identity.orgId = "org-2";
    act(() => rerender());
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "GET")).toHaveLength(2)
    );
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("recovering a read that never landed", () => {
  /**
   * One failed GET used to pin the row read-only for the life of the mount, and
   * a desktop Sessions view can stay mounted for days — so a launch while
   * offline stopped the account copy updating with nothing said about it
   * (marisolashgrove review, PR #7081). The reader's next change retries the read.
   *
   * COUNTERFACTUAL: restore `discardPending` on a null read and leave the
   * debounce calling `flushSync` directly (how it was first written) and the
   * second GET never happens, so `calls` stays at 1 and no write is ever issued.
   */
  it("retries the read on the next publish, then sends the held change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // No local record, so the retried read has nothing to seed the row with and
    // the only write this case can produce is the reader's own change.
    localStorage.removeItem(STORAGE_KEY);
    let readLands = false;
    const { adapter, calls } = createTransport((call) => {
      if (call.method === "GET") {
        return readLands
          ? { body: missingBody(), status: 200 }
          : { body: { error: "offline", success: false }, status: 503 };
      }
      return { body: storedBody({ width: 2 }, 1), status: 200 };
    });

    const { result } = renderMovableRemote(adapter, {
      enabled: true,
      userId: "user-1",
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(writes(calls)).toHaveLength(0);

    readLands = true;
    act(() => result.current.publish(JSON.stringify({ width: 2 })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(writes(calls)[0].body).toMatchObject({ value: { width: 2 } });
    // Still no row to compare against, so the first write creates one rather
    // than carrying a revision the retried read never returned.
    expect(writes(calls)[0].body).not.toHaveProperty("expectedRevision");
  });

  /**
   * The retry is not a promise that the change saved. When it fails too, the
   * bytes are held for the NEXT retry and the reader is told the account copy
   * did not take them — the local record still has the layout.
   *
   * COUNTERFACTUAL: drop the `sync.pending !== null` toast and the reader sees
   * nothing at all while their change stops reaching the account, which is the
   * silent failure the thread names.
   */
  it("says the account copy did not save when the retry fails too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport(() => ({
      body: { error: "offline", success: false },
      status: 503,
    }));

    const { result } = renderMovableRemote(adapter, {
      enabled: true,
      userId: "user-1",
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The mount read failed with nothing pending: the reader did nothing, so
    // there is nothing to report.
    expect(toastCalls.error).toHaveLength(0);

    act(() => result.current.publish(JSON.stringify({ width: 3 })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(toastCalls.error).toEqual([GRID_PREFERENCE_WRITE_FAILED_MESSAGE])
    );
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(writes(calls)).toHaveLength(0);
    // Nothing was undone on screen and the device still holds the layout.
    expect(result.current.inbound).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(LOCAL_VIEW);
  });
});

describe("honest rollback", () => {
  it("puts the last confirmed layout back and says so when a write fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter } = createTransport((call) =>
      call.method === "GET"
        ? { body: foundBody(SERVER_VIEW, 3), status: 200 }
        : { body: { error: "boom", success: false }, status: 500 }
    );

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());
    const adoptedSeq = result.current.inbound?.seq ?? 0;

    act(() => result.current.publish(JSON.stringify({ sortKey: "date" })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(result.current.inbound?.seq).toBeGreaterThan(adoptedSeq)
    );
    // The WHOLE previous record comes back, so no other axis is lost with it.
    expect(result.current.inbound?.serialized).toBe(
      JSON.stringify(SERVER_VIEW)
    );
    expect(toastCalls.error).toHaveLength(1);
  });

  it("keeps the local choice and reports the failure when nothing was ever confirmed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport((call) =>
      call.method === "GET"
        ? { body: missingBody(), status: 200 }
        : { body: { error: "boom", success: false }, status: 500 }
    );

    const { result } = renderRemote(adapter);
    // The import goes out and fails; a background adoption the reader never
    // asked for says nothing, and the next mount tries again.
    await vi.waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(toastCalls.error).toHaveLength(0);

    act(() => result.current.publish(JSON.stringify({ sortKey: "date" })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    // A change the reader DID make is reported, and nothing is undone: there is
    // no confirmed layout to return to, and the local record still holds it.
    await vi.waitFor(() => expect(toastCalls.error).toHaveLength(1));
    expect(result.current.inbound).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(LOCAL_VIEW);
  });

  /**
   * COUNTERFACTUAL: record only `confirmed` on a successful write and leave
   * `confirmedSerialized` holding the ADOPTED bytes (how it was first written)
   * and the rollback returns the view two steps back, to `SERVER_VIEW`.
   */
  it("rolls back to the last CONFIRMED layout, not the one adopted on mount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepted = { sortKey: "accepted" };
    let acceptNext = true;
    const { adapter } = createTransport((call) => {
      if (call.method === "GET") {
        return { body: foundBody(SERVER_VIEW, 3), status: 200 };
      }
      if (acceptNext) {
        acceptNext = false;
        return { body: storedBody(accepted, 4), status: 200 };
      }
      return { body: { error: "boom", success: false }, status: 500 };
    });

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify(accepted)));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(toastCalls.error).toHaveLength(0));

    act(() => result.current.publish(JSON.stringify({ sortKey: "rejected" })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(toastCalls.error).toHaveLength(1));
    expect(result.current.inbound?.serialized).toBe(JSON.stringify(accepted));
  });

  /**
   * COUNTERFACTUAL: treat a 409 like any other failure (drop the
   * `isRevisionConflict` branch) and the re-read never happens, so the second
   * GET is absent and the surface goes on showing a layout the account rejected.
   */
  it("re-reads the authoritative row after a rejected write", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const remoteView = { sortKey: "elsewhere" };
    let reads = 0;
    const { adapter } = createTransport((call) => {
      if (call.method === "GET") {
        reads += 1;
        return {
          body: foundBody(
            reads === 1 ? SERVER_VIEW : remoteView,
            reads === 1 ? 3 : 9
          ),
          status: 200,
        };
      }
      return {
        body: {
          data: { code: "grid_preference_stale_revision" },
          error: "stale",
          success: false,
        },
        status: 409,
      };
    });

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());

    act(() => result.current.publish(JSON.stringify({ sortKey: "mine" })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(result.current.inbound?.serialized).toBe(
        JSON.stringify(remoteView)
      )
    );
    expect(reads).toBe(2);
    expect(toastCalls.info).toHaveLength(1);
  });

  /**
   * The writer that beat us DELETED the row. Recovering through the mount-time
   * adoption would read `missing`, take the import branch, and seed the row back
   * from the very bytes the server just refused — undoing a deletion nobody
   * asked to undo.
   *
   * COUNTERFACTUAL: route the 409 back through `runAdoption` (how it was first
   * written, via the re-read nonce) and a second POST goes out carrying the
   * local record, so `writes(calls)` is 2 and the screen keeps the rejected
   * layout instead of falling back.
   */
  it("never re-imports the rejected layout when the row was deleted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    const { adapter, calls } = createTransport((call) => {
      if (call.method === "GET") {
        reads += 1;
        return {
          body: reads === 1 ? foundBody(SERVER_VIEW, 3) : missingBody(),
          status: 200,
        };
      }
      return {
        body: {
          data: { code: "grid_preference_stale_revision" },
          error: "stale",
          success: false,
        },
        status: 409,
      };
    });

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());
    const adoptedSeq = result.current.inbound?.seq ?? 0;

    act(() => result.current.publish(JSON.stringify({ sortKey: "mine" })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(reads).toBe(2));
    await vi.waitFor(() =>
      expect(result.current.inbound?.seq).toBeGreaterThan(adoptedSeq)
    );
    expect(writes(calls)).toHaveLength(1);
    // No authoritative record to show, so the screen goes to the last layout
    // this session confirmed and the reader is told the write did not save.
    expect(result.current.inbound?.serialized).toBe(
      JSON.stringify(SERVER_VIEW)
    );
    expect(toastCalls.error).toHaveLength(1);
    expect(toastCalls.info).toHaveLength(0);
  });

  /**
   * COUNTERFACTUAL: as above — routed through the mount-time adoption a failed
   * re-read yields no answer at all, so nothing is delivered and the surface
   * goes on showing bytes the account rejected.
   */
  it("falls back to the last confirmed layout when the re-read fails too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    const { adapter, calls } = createTransport((call) => {
      if (call.method === "GET") {
        reads += 1;
        return reads === 1
          ? { body: foundBody(SERVER_VIEW, 3), status: 200 }
          : { body: { error: "nope", success: false }, status: 500 };
      }
      return {
        body: {
          data: { code: "grid_preference_stale_revision" },
          error: "stale",
          success: false,
        },
        status: 409,
      };
    });

    const { result } = renderRemote(adapter);
    await vi.waitFor(() => expect(result.current.inbound).not.toBeNull());
    const adoptedSeq = result.current.inbound?.seq ?? 0;

    act(() => result.current.publish(JSON.stringify({ sortKey: "mine" })));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(result.current.inbound?.seq).toBeGreaterThan(adoptedSeq)
    );
    expect(result.current.inbound?.serialized).toBe(
      JSON.stringify(SERVER_VIEW)
    );
    expect(writes(calls)).toHaveLength(1);
    expect(toastCalls.error).toHaveLength(1);
  });
});
