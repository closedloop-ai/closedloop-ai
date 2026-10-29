import type {
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import type {
  AuthAdapter,
  AuthSnapshot,
} from "@repo/app/shared/auth/auth-adapter";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { DESKTOP_AUTH_TOKEN_SENTINEL } from "../../shared/cloud-api-fetch-contract";
import { DesktopSignInAccountConfirmDialog } from "../components/desktop-sign-in-account-confirm-dialog";
import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
  DesktopSignInOptions,
} from "../types/desktop-api";
import { type BridgeStore, createBridgeStore } from "./bridge-store";

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

type DesktopAuthStore = BridgeStore<DesktopAuthState>;

/**
 * External store that mirrors the main-process auth state into the renderer over
 * IPC (see {@link createBridgeStore} for the shared wiring/teardown contract).
 * Bridge-absent (a partial test stub) settles to a signed-out, loaded snapshot
 * rather than stranding the app-core root in "loading" (`initial`).
 */
export function createDesktopAuthStore(): DesktopAuthStore {
  return createBridgeStore<DesktopAuthState>({
    hasBridge: hasDesktopAuthBridge,
    pull: () => window.desktopApi.getDesktopAuthState(),
    // Optional-chain the subscription: a harness may stub the pull but not the
    // push channel.
    subscribe: (onChange) =>
      window.desktopApi.onDesktopAuthStateChanged?.(onChange),
    initial: LOADING_STATE,
    fallback: SIGNED_OUT_STATE,
  });
}

export type DesktopAuthContextValue = {
  /** Live main-process auth state (status + identity). */
  state: DesktopAuthState;
  /** Begin interactive system-browser sign-in. */
  /**
   * ISS-5112 / ISS-5954: `method` pre-selects the sign-in flow on the web
   * detour — a social provider's consent screen, or the email form. Optional —
   * omit it and the web page runs its GitHub default. `emailHint` (M5) carries
   * the typed address so the email form opens prefilled, and `framing` names
   * the door's sign-up vs sign-in intent so that form is the matching Clerk
   * embed; both are meaningful only with the email method. `options` carries
   * ISS-11345's `confirmAccount`, which holds the returned account for the
   * user to confirm before it is adopted; a Cancel there settles as `declined`.
   */
  beginSignIn: (
    method?: DesktopSignInMethod,
    emailHint?: string,
    framing?: DesktopSignInFraming,
    options?: DesktopSignInOptions
  ) => Promise<DesktopBrowserSignInResult>;
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
 * `getToken()` never surfaces the real access token (PLN-1138 D-G): while a
 * desktop session exists it resolves the opaque
 * {@link DESKTOP_AUTH_TOKEN_SENTINEL} — enough for the shared `useApiClient`
 * to treat the surface as signed in — and the main-process cloud-API fetch
 * bridge attaches the genuine credential itself. The token has no renderer
 * IPC channel at all.
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
  // ISS-11345: the latest sign-in call, so a Cancel in the account confirmation
  // marks the call it answered. Main settles that run as a plain `cancelled`.
  const signInCallRef = useRef<{ declined: boolean } | null>(null);

  const authAdapter = useMemo<AuthAdapter>(() => {
    // Sentinel, not the credential (PLN-1138 D-G): non-null while a session
    // exists so `useApiClient` composes an Authorization header and its
    // signed-in token-wait settles; the cloud-API fetch bridge discards it and
    // the main process injects the real token. Null in every other state keeps
    // signed-out requests unauthenticated.
    const token =
      state.status === "authenticated" ? DESKTOP_AUTH_TOKEN_SENTINEL : null;
    const snapshot: AuthSnapshot = {
      isLoaded: state.status !== "loading",
      userId: state.userId,
      orgId: state.organizationId,
      getToken: () => Promise.resolve(token),
    };
    // Static per-state snapshot: returning the closed-over object satisfies the
    // referential-stability contract without calling any hooks.
    return { useAuthSnapshot: () => snapshot };
  }, [state]);

  // The sign-in actions honor the same bridge-absent guard as the state sync and
  // getToken above. In the packaged app the preload always attaches these; when a
  // partial test stub omits them, fail safe (surface "unavailable" / no-op)
  // instead of throwing on a bare `window.desktopApi`.
  const contextValue = useMemo<DesktopAuthContextValue>(
    () => ({
      state,
      beginSignIn: async (
        method?: DesktopSignInMethod,
        emailHint?: string,
        framing?: DesktopSignInFraming,
        options?: DesktopSignInOptions
      ): Promise<DesktopBrowserSignInResult> => {
        if (!hasDesktopAuthBridge()) {
          return { ok: false, reason: "unavailable" };
        }
        const call = { declined: false };
        signInCallRef.current = call;
        const result = await window.desktopApi.beginDesktopSignIn(
          method,
          emailHint,
          framing,
          options
        );
        return !result.ok && call.declined
          ? { ok: false, reason: "declined" }
          : result;
      },
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
      {/* ISS-11345: rendered by the provider that owns the auth state, so any
          surface's confirmation-gated sign-in is answerable wherever the user
          is, and no host can forget to mount it. */}
      {state.pendingAccount ? (
        <DesktopSignInAccountConfirmDialog
          account={state.pendingAccount}
          onCancel={() => {
            if (signInCallRef.current) {
              signInCallRef.current.declined = true;
            }
            contextValue.cancelSignIn().catch(() => undefined);
          }}
          onConfirm={() => {
            // A preload without the method, or a confirm that never reached
            // main, would leave the dialog waiting forever; end the sign-in so
            // the user stays a guest.
            const endSignIn = () => {
              contextValue.cancelSignIn().catch(() => undefined);
            };
            if (window.desktopApi.confirmDesktopSignIn) {
              window.desktopApi.confirmDesktopSignIn().catch(endSignIn);
            } else {
              endSignIn();
            }
          }}
        />
      ) : null}
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

/**
 * ISS-11426: the same state, for a component that must render OUTSIDE a
 * {@link DesktopAuthProvider} as well as inside one.
 *
 * `useDesktopAuth` throws by design — a surface whose whole job is the account
 * panel has no honest behaviour without the provider. A Settings section that
 * merely wants to build an org-scoped web link does: every Settings mount site
 * that does not wrap the provider (several coverage suites, and any future
 * embed) would otherwise crash on an unrelated block, which is exactly what
 * happened when the compute-target relink alert reached for the throwing hook.
 * Null here means "no provider", and a caller reads it the same way it reads a
 * signed-out state: withhold the account-scoped affordance.
 */
export function useDesktopAuthOptional(): DesktopAuthContextValue | null {
  return useContext(DesktopAuthContext);
}
