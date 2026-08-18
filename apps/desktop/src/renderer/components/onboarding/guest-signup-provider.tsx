import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useReducer,
} from "react";

/**
 * Lazy, deliberately. This provider wraps the whole app shell, and a static
 * import would pull `DesktopOnboardingFlow` — and the shared onboarding and
 * analytics modules behind it — into the shell's initial chunk, which
 * `insights-route-lazy-load.test.tsx` exists to prevent. Nothing about the ask
 * is needed until a guest makes one.
 */
const AccountDialog = lazy(() =>
  import("./account-dialog").then((module) => ({
    default: module.AccountDialog,
  }))
);

/**
 * ISS-5112 (PLN-1600 Step D) — which surface asked a guest for an account.
 *
 * The identity of the ask is carried THROUGH sign-up so the app can finish the
 * job it interrupted: someone who asked for organization insights should land on
 * organization scope, and someone who asked to invite a teammate should get the
 * invite dialog back. A boolean "did they sign up" expresses neither.
 */
export const GuestSignupIntent = {
  Header: "header",
  Organization: "organization",
  Invite: "invite",
  Tour: "tour",
} as const;
export type GuestSignupIntent =
  (typeof GuestSignupIntent)[keyof typeof GuestSignupIntent];

export type GuestSignupState = {
  /** The intent currently asking, or null when nothing is being asked. */
  pending: GuestSignupIntent | null;
  /**
   * The intent whose sign-up COMPLETED and has not been acted on yet. Separate
   * from `pending` because by then the ask is over but the resume has not
   * happened — only the surface owning the original job can finish it, and it
   * clears this once it has.
   */
  resuming: GuestSignupIntent | null;
};

export type GuestSignupAction =
  | { type: "request"; intent: GuestSignupIntent }
  | { type: "dismiss" }
  | { type: "signed-up" }
  | { type: "resumed" };

export const INITIAL_GUEST_SIGNUP_STATE: GuestSignupState = {
  pending: null,
  resuming: null,
};

export function guestSignupReducer(
  state: GuestSignupState,
  action: GuestSignupAction
): GuestSignupState {
  switch (action.type) {
    case "request":
      return { ...state, pending: action.intent };
    case "dismiss":
      // Backing out abandons the job too. Nothing to resume: the person said no.
      return { ...state, pending: null };
    case "signed-up":
      return { pending: null, resuming: state.pending };
    case "resumed":
      return { ...state, resuming: null };
    // Unreachable: `GuestSignupAction` is a closed union and every member is
    // handled above. Kept because Biome's `useDefaultSwitchClause` requires it,
    // so it stays an uncovered branch rather than one worth a test that would
    // have to cast past the type to reach it.
    default:
      return state;
  }
}

type GuestSignupContextValue = {
  /** Ask for an account on behalf of a surface. */
  requestSignup: (intent: GuestSignupIntent) => void;
  /** The intent whose sign-up completed and still needs resuming. */
  resuming: GuestSignupIntent | null;
  /** Clear the resume marker once the owning surface has acted on it. */
  clearResume: () => void;
};

const NOOP_VALUE: GuestSignupContextValue = {
  requestSignup: () => undefined,
  resuming: null,
  clearResume: () => undefined,
};

/**
 * Defaults to inert rather than throwing.
 *
 * The consumers are the sidebar, the topbar and the dashboard — three of the
 * most-mounted surfaces in the app, each with existing tests and stories that
 * know nothing about this provider. A throwing hook would break every one of
 * those mount sites at once for a feature that is off by default anyway.
 */
const GuestSignupContext = createContext<GuestSignupContextValue>(NOOP_VALUE);

export function GuestSignupProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    guestSignupReducer,
    INITIAL_GUEST_SIGNUP_STATE
  );

  const requestSignup = useCallback(
    (intent: GuestSignupIntent) => dispatch({ type: "request", intent }),
    []
  );
  const clearResume = useCallback(() => dispatch({ type: "resumed" }), []);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      dispatch({ type: "dismiss" });
    }
  }, []);
  const handleSignedUp = useCallback(() => dispatch({ type: "signed-up" }), []);

  const value = useMemo(
    () => ({ requestSignup, resuming: state.resuming, clearResume }),
    [requestSignup, state.resuming, clearResume]
  );

  return (
    <GuestSignupContext.Provider value={value}>
      {children}
      {/*
        One dialog for all four entry points, mounted here rather than per
        surface. The header, the invite item, the scope toggle and the tour all
        open the SAME offer and the same real DesktopOnboardingFlow behind it —
        four copies would be four things to keep in step.

        Mounted only while something is pending, not kept mounted and toggled
        `open`. `AccountDialog` reads `useDesktopAuth` (it has to cancel an
        in-flight browser sign-in on dismiss), and this provider wraps the whole
        app shell — including the app-shell routing tests, which mount the shell
        with no auth provider above it. Conditional mounting keeps that hook off
        the tree until a guest has actually asked for an account. The cost is the
        close animation, which unmounts rather than plays out.
      */}
      {state.pending !== null && (
        <Suspense fallback={null}>
          <AccountDialog
            intent={state.pending}
            onOpenChange={handleOpenChange}
            onSignedUp={handleSignedUp}
            open
          />
        </Suspense>
      )}
    </GuestSignupContext.Provider>
  );
}

export function useGuestSignup(): GuestSignupContextValue {
  return useContext(GuestSignupContext);
}
