import { useAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopAuthProvider,
  useDesktopAuth,
} from "../shared-agent-sessions/desktop-auth-provider";
import type { DesktopAuthState } from "../types/desktop-api";

type AuthStateListener = (state: DesktopAuthState) => void;

const SIGNED_OUT: DesktopAuthState = {
  status: "signed_out",
  userId: null,
  organizationId: null,
};
const AUTHENTICATED: DesktopAuthState = {
  status: "authenticated",
  userId: "user-1",
  organizationId: "org-1",
};

function setupDesktopApi(initial: DesktopAuthState) {
  const listeners = new Set<AuthStateListener>();
  const api = {
    getDesktopAuthState: vi.fn(() => Promise.resolve(initial)),
    onDesktopAuthStateChanged: vi.fn((cb: AuthStateListener) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    beginDesktopSignIn: vi.fn(() => Promise.resolve({ ok: true as const })),
    cancelDesktopSignIn: vi.fn(() => Promise.resolve()),
    signOutDesktop: vi.fn(() => Promise.resolve()),
    getDesktopAccessToken: vi.fn(() => Promise.resolve("access-token")),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return {
    api,
    push: (state: DesktopAuthState) => {
      for (const cb of listeners) {
        cb(state);
      }
    },
  };
}

function useCombined() {
  return { auth: useDesktopAuth(), snapshot: useAuthSnapshot() };
}

describe("DesktopAuthProvider", () => {
  it("pulls the initial state and exposes it via the snapshot + context", async () => {
    setupDesktopApi(SIGNED_OUT);
    const { result } = renderHook(useCombined, {
      wrapper: DesktopAuthProvider,
    });

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe("signed_out")
    );
    expect(result.current.snapshot.isLoaded).toBe(true);
    expect(result.current.snapshot.userId).toBeNull();
    expect(result.current.snapshot.orgId).toBeNull();
  });

  it("maps a pushed authenticated state into the AuthSnapshot", async () => {
    const { push } = setupDesktopApi(SIGNED_OUT);
    const { result } = renderHook(useCombined, {
      wrapper: DesktopAuthProvider,
    });
    await waitFor(() =>
      expect(result.current.auth.state.status).toBe("signed_out")
    );

    act(() => push(AUTHENTICATED));

    await waitFor(() => expect(result.current.snapshot.userId).toBe("user-1"));
    expect(result.current.snapshot.orgId).toBe("org-1");
    expect(result.current.snapshot.isLoaded).toBe(true);
    expect(result.current.auth.state.status).toBe("authenticated");
  });

  it("getToken proxies to the main-process access token", async () => {
    const { api } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(useCombined, {
      wrapper: DesktopAuthProvider,
    });
    await waitFor(() =>
      expect(result.current.auth.state.status).toBe("authenticated")
    );

    await expect(result.current.snapshot.getToken()).resolves.toBe(
      "access-token"
    );
    expect(api.getDesktopAccessToken).toHaveBeenCalled();
  });

  it("sign-in/cancel/sign-out actions delegate to the bridge", async () => {
    const { api } = setupDesktopApi(SIGNED_OUT);
    const { result } = renderHook(useCombined, {
      wrapper: DesktopAuthProvider,
    });
    await waitFor(() =>
      expect(result.current.auth.state.status).toBe("signed_out")
    );

    await act(async () => {
      await result.current.auth.beginSignIn();
    });
    await act(async () => {
      await result.current.auth.cancelSignIn();
    });
    await act(async () => {
      await result.current.auth.signOut();
    });

    expect(api.beginDesktopSignIn).toHaveBeenCalledTimes(1);
    expect(api.cancelDesktopSignIn).toHaveBeenCalledTimes(1);
    expect(api.signOutDesktop).toHaveBeenCalledTimes(1);
  });

  it("degrades to signed-out (loaded) when the auth bridge is absent", () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {},
    });
    const { result } = renderHook(useCombined, {
      wrapper: DesktopAuthProvider,
    });

    expect(result.current.auth.state.status).toBe("signed_out");
    expect(result.current.snapshot.isLoaded).toBe(true);
  });
});
