import type {
  AuthAdapter,
  AuthSnapshot,
} from "@repo/app/shared/auth/auth-adapter";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
} from "../types/desktop-api";

const LOADING_STATE: DesktopAuthState = {
  status: "loading",
  userId: null,
  organizationId: null,
};

const SIGNED_OUT_STATE: DesktopAuthState = {
  status: "signed_out",
  userId: null,
  organizationId: null,
};

/**
 * Whether the main-process auth bridge is exposed. Always true in the packaged
 * app (the preload exposes it); false only in unit-test harnesses that stub a
 * partial `window.desktopApi`. When absent we settle to a signed-out (loaded)
 * state rather than stranding the app-core root in "loading".
 */
function hasDesktopAuthBridge(): boolean {
  return typeof window.desktopApi?.getDesktopAuthState === "function";
}

type DesktopAuthStore = {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => DesktopAuthState;
};

/**
 * External store that mirrors the main-process auth state into the renderer over
 * IPC, shaped for {@link useSyncExternalStore}: `subscribe` wires the bridge —
 * an initial pull plus a push subscription for every transition — on the first
 * listener and tears it down on the last, and `getSnapshot` returns the latest
 * mirrored snapshot (a stable reference between transitions). Bridge-absent (a
 * partial test stub) settles to a signed-out, loaded snapshot rather than
 * stranding the app-core root in "loading".
 */
function createDesktopAuthStore(): DesktopAuthStore {
  let snapshot: DesktopAuthState = hasDesktopAuthBridge()
    ? LOADING_STATE
    : SIGNED_OUT_STATE;
  const listeners = new Set<() => void>();
  let unwire: (() => void) | undefined;

  const setSnapshot = (next: DesktopAuthState) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const wire = () => {
    if (!hasDesktopAuthBridge()) {
      return;
    }
    let cancelled = false;
    window.desktopApi
      .getDesktopAuthState()
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      })
      .catch(() => {
        // Main unreachable → stay in loading; a later push corrects it.
      });
    // Optional-chain the subscription: a harness may stub the pull but not the
    // push channel.
    const unsubscribe =
      window.desktopApi.onDesktopAuthStateChanged?.(setSnapshot);
    unwire = () => {
      cancelled = true;
      unsubscribe?.();
      unwire = undefined;
    };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (onStoreChange) => {
      if (listeners.size === 0) {
        wire();
      }
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0) {
          unwire?.();
        }
      };
    },
  };
}

export type DesktopAuthContextValue = {
  /** Live main-process auth state (status + identity). */
  state: DesktopAuthState;
  /** Begin interactive system-browser sign-in. */
  beginSignIn: () => Promise<DesktopBrowserSignInResult>;
  /** Cancel an in-flight sign-in (no-op when none is running). */
  cancelSignIn: () => Promise<void>;
  /** Sign out and clear credentials. */
  signOut: () => Promise<void>;
};

const DesktopAuthContext = createContext<DesktopAuthContextValue | null>(null);

/**
 * Desktop shell adapter for the `@repo/app` auth port (FEA-2219).
 *
 * Mirrors the main-process {@link DesktopSessionManager} state into the
 * renderer — an initial pull on mount plus a push subscription for every
 * transition — and exposes it two ways: the surface-agnostic `AuthAdapter`
 * (`isLoaded`/`userId`/`orgId`/`getToken`) that `@repo/app` consumes, and a
 * desktop-only context (full state machine + sign-in/out actions) for the
 * Settings account panel. Replaces the static signed-out adapter the renderer
 * used before first-party desktop auth existed.
 *
 * `getToken()` is the only path that surfaces an access token to the renderer,
 * for `Authorization: Bearer` attachment; it is fetched on demand from main and
 * never held here.
 */
export function DesktopAuthProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  // One store per provider instance (lazy-init ref keeps subscribe/getSnapshot
  // referentially stable so useSyncExternalStore doesn't re-subscribe on render).
  const storeRef = useRef<DesktopAuthStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createDesktopAuthStore();
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Stable across renders: getToken always proxies to main regardless of state,
  // so consumers depending on it in effect deps don't re-run on every auth tick.
  // Bridge-absent (partial test stub) is fail-safe: honor the nullable
  // AuthSnapshot.getToken contract with null rather than throwing.
  const getToken = useCallback(
    () =>
      hasDesktopAuthBridge()
        ? window.desktopApi.getDesktopAccessToken()
        : Promise.resolve(null),
    []
  );

  const authAdapter = useMemo<AuthAdapter>(() => {
    const snapshot: AuthSnapshot = {
      isLoaded: state.status !== "loading",
      userId: state.userId,
      orgId: state.organizationId,
      getToken,
    };
    // Static per-state snapshot: returning the closed-over object satisfies the
    // referential-stability contract without calling any hooks.
    return { useAuthSnapshot: () => snapshot };
  }, [state, getToken]);

  // The sign-in actions honor the same bridge-absent guard as the state sync and
  // getToken above. In the packaged app the preload always attaches these; when a
  // partial test stub omits them, fail safe (surface "unavailable" / no-op)
  // instead of throwing on a bare `window.desktopApi`.
  const contextValue = useMemo<DesktopAuthContextValue>(
    () => ({
      state,
      beginSignIn: () =>
        hasDesktopAuthBridge()
          ? window.desktopApi.beginDesktopSignIn()
          : Promise.resolve<DesktopBrowserSignInResult>({
              ok: false,
              reason: "unavailable",
            }),
      cancelSignIn: () =>
        hasDesktopAuthBridge()
          ? window.desktopApi.cancelDesktopSignIn()
          : Promise.resolve(),
      signOut: () =>
        hasDesktopAuthBridge()
          ? window.desktopApi.signOutDesktop()
          : Promise.resolve(),
    }),
    [state]
  );

  return (
    <DesktopAuthContext.Provider value={contextValue}>
      <AuthAdapterProvider adapter={authAdapter}>
        {children}
      </AuthAdapterProvider>
    </DesktopAuthContext.Provider>
  );
}

/**
 * Desktop auth state + sign-in/out actions for shell UI (the Settings account
 * panel). Throws when used outside {@link DesktopAuthProvider}.
 */
export function useDesktopAuth(): DesktopAuthContextValue {
  const value = useContext(DesktopAuthContext);
  if (!value) {
    throw new Error(
      "useDesktopAuth requires a <DesktopAuthProvider> ancestor (mounted in DesktopAppCoreProvider)."
    );
  }
  return value;
}
