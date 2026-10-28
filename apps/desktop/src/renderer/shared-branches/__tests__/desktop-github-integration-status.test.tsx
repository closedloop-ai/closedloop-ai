import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import { resolveGitHubDataConnected } from "@repo/api/src/types/github-data-connected";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopGitHubIntegrationStatus } from "../desktop-github-integration-status";

/**
 * ISS-7869 — the desktop's own GitHub connection read.
 *
 * It exists because `@repo/app`'s `useGitHubIntegrationStatus` calls
 * `useApiClient()`, which throws without an `<ApiAdapterProvider>`; this hook
 * asks the main process the same question over IPC and needs no provider at
 * all. What is worth pinning is not the plumbing but the THREE-valued answer:
 * connected, disconnected, and unknown — because collapsing the third into the
 * second is what puts a "Connect GitHub" ask in front of a connected user
 * (ISS-5958), and it is reachable here on every first render and every failed
 * read.
 */

type DesktopApiStub = {
  getGitHubIntegrationStatus?: () => Promise<GitHubIntegrationStatus | null>;
};

function statusFixture({
  connected,
}: {
  connected: boolean;
}): GitHubIntegrationStatus {
  return {
    connected,
    githubDataConnection: { connected },
  } as GitHubIntegrationStatus;
}

const DESKTOP_API_KEY = "desktopApi";
let originalDesktopApi: PropertyDescriptor | undefined;

/**
 * Replace ONLY `window.desktopApi`, never `window` itself: swapping the whole
 * global leaves testing-library without a real document to render into.
 */
function stubDesktopApi(api: DesktopApiStub | undefined): void {
  originalDesktopApi ??= Object.getOwnPropertyDescriptor(
    globalThis.window,
    DESKTOP_API_KEY
  );
  if (api === undefined) {
    Reflect.deleteProperty(globalThis.window, DESKTOP_API_KEY);
    return;
  }
  Reflect.set(globalThis.window, DESKTOP_API_KEY, api);
}

afterEach(() => {
  // Restore the exact previous state: a property that was originally ABSENT is
  // removed, not set to undefined.
  if (originalDesktopApi) {
    Object.defineProperty(
      globalThis.window,
      DESKTOP_API_KEY,
      originalDesktopApi
    );
  } else {
    Reflect.deleteProperty(globalThis.window, DESKTOP_API_KEY);
  }
  originalDesktopApi = undefined;
  vi.restoreAllMocks();
});

describe("useDesktopGitHubIntegrationStatus, read as a connection verdict", () => {
  it("reports UNKNOWN before the read lands, never disconnected", () => {
    // Held open deliberately: the first render is the window in which a
    // premature `false` would render an ask at every mount.
    stubDesktopApi({ getGitHubIntegrationStatus: () => new Promise(() => {}) });

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );

    expect(result.current).toBeUndefined();
  });

  it("reports connected from the either-source field", async () => {
    // `githubDataConnection.connected` is the field that answers EITHER source
    // — an active personal grant OR an org App installation — which is the whole
    // point of `resolveGitHubDataConnected` (ISS-5958).
    stubDesktopApi({
      getGitHubIntegrationStatus: () =>
        Promise.resolve(statusFixture({ connected: true })),
    });

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("reports disconnected only when the payload actually says so", async () => {
    stubDesktopApi({
      getGitHubIntegrationStatus: () =>
        Promise.resolve(statusFixture({ connected: false })),
    });

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );

    await waitFor(() => expect(result.current).toBe(false));
  });

  it("stays UNKNOWN on a payload carrying neither connection field", async () => {
    // A version-skewed peer that predates the field. Calling this disconnected
    // asserts a fact the payload never carried.
    const getGitHubIntegrationStatus = vi.fn().mockResolvedValue({});
    stubDesktopApi({ getGitHubIntegrationStatus });

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );

    await waitFor(() => expect(getGitHubIntegrationStatus).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("stays UNKNOWN when the IPC read rejects", async () => {
    const getGitHubIntegrationStatus = vi
      .fn()
      .mockRejectedValue(new Error("ipc down"));
    stubDesktopApi({ getGitHubIntegrationStatus });

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );

    // Drive the production entry point, then assert from the test body that the
    // failed read left the answer unknown rather than asserting "not connected".
    await waitFor(() => expect(getGitHubIntegrationStatus).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("stays UNKNOWN when the preload bridge is absent entirely", async () => {
    // A renderer mounted before preload lands, and every test site that never
    // stubs `desktopApi`. This must not throw — SessionsView has a case pinning
    // exactly that.
    stubDesktopApi(undefined);

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );

    await waitFor(() => expect(result.current).toBeUndefined());
  });

  it("ignores an older read that lands after a newer one", async () => {
    // ISS-7866 review (tamsinb). Focus and visibilitychange can both fire on a
    // single alt-tab, putting two reads in flight. A cancel flag only covers
    // unmount — without a sequence guard the SLOWER, older response lands last
    // and wins, re-lighting the ask after a connect that already succeeded.
    const resolvers: ((value: GitHubIntegrationStatus | null) => void)[] = [];
    stubDesktopApi({
      getGitHubIntegrationStatus: () =>
        new Promise<GitHubIntegrationStatus | null>((resolve) => {
          resolvers.push(resolve);
        }),
    });

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );
    act(() => {
      globalThis.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(resolvers.length).toBe(2));

    // Newer (the focus re-read) settles first, then the stale mount read. The
    // awaited microtask flush is load-bearing: without it the stale resolve has
    // not been applied yet when the assertion runs, and the case would pass
    // even with the guard removed.
    await act(async () => {
      resolvers[1](statusFixture({ connected: true }));
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0](statusFixture({ connected: false }));
      await Promise.resolve();
    });

    expect(result.current).toBe(true);
  });

  it("re-reads on focus, so a completed connect clears the ask", async () => {
    // ISS-7866 review: the connect handoff finishes in the BROWSER. With only a
    // mount read, a user who connects successfully comes back to a strip still
    // telling them to connect — the ask outliving the thing it asks for.
    let connected = false;
    const getGitHubIntegrationStatus = vi.fn(() =>
      Promise.resolve(statusFixture({ connected }))
    );
    stubDesktopApi({ getGitHubIntegrationStatus });

    const { result } = renderHook(() =>
      resolveGitHubDataConnected(useDesktopGitHubIntegrationStatus())
    );
    await waitFor(() => expect(result.current).toBe(false));

    // The connect lands out of band, then the window comes back.
    connected = true;
    act(() => {
      globalThis.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(getGitHubIntegrationStatus).toHaveBeenCalledTimes(2);
  });
});
