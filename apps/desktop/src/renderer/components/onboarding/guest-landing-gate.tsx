import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useNavigation } from "@repo/navigation/use-navigation";
import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { useDesktopFeatureFlagsResolved } from "../../feature-flags/desktop-feature-flag-provider";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { macStoplightClearance } from "../../platform";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  dashboardOnboardedStorageKey,
  desktopLandingSeenStorageKey,
  readFlag,
  writeFlag,
} from "../dashboard/dashboard-storage-keys";
import {
  DesktopOnboardingFlow,
  SIGN_IN_AUTH_COPY,
} from "./desktop-onboarding-flow";
import {
  GuestLanding,
  GuestLandingDragStrip,
  GuestLandingHeader,
  GuestLandingHold,
} from "./guest-landing";
import {
  canOfferAccount,
  type GuestOnboardingState,
  useGuestOnboarding,
} from "./use-guest-onboarding";

/** Names the destination, not just the direction. */
const BACK_LABEL = "Back to landing";

/**
 * Whether this LAUNCH is even a candidate for the landing — the half of the
 * decision that can be made without an auth context.
 *
 * Split from {@link shouldShowGuestLanding} for a structural reason, not a
 * stylistic one: reading auth requires a `DesktopAuthProvider`, which
 * `main.tsx` mounts in the real app but the app-shell suites deliberately do
 * not. Answering "is this install a candidate" first lets the flag-off default
 * — every existing user, and every one of those tests — return the shell
 * without ever mounting the hook that would throw.
 */
export function isGuestLandingArmed({
  flagEnabled,
  flagsResolved,
  firstRun,
}: {
  flagEnabled: boolean;
  /** ISS-5037: an unresolved snapshot reads every flag as its default, so it counts as off. */
  flagsResolved: boolean;
  /** This install has never answered the landing nor completed a first-launch reveal. */
  firstRun: boolean;
}): boolean {
  return flagsResolved && flagEnabled && firstRun;
}

/**
 * Whether an armed launch shows the landing to THIS person right now.
 *
 * Pure so the decision can be tested without a window, a bridge or a flag
 * snapshot — the components below own only the storage reads that feed it.
 */
export function shouldShowGuestLanding({
  guest,
  signingIn,
}: {
  guest: GuestOnboardingState;
  /** A sign-in started FROM the landing is still in flight. */
  signingIn: boolean;
}): boolean {
  // Hold the takeover through an in-flight sign-in. Auth leaves `signed_out` the
  // moment the browser opens, so deferring to `canOfferAccount` alone would rip
  // the landing away mid-flow and drop the person into the app they had not
  // chosen to enter — and leave them nowhere if they then cancelled.
  if (signingIn) {
    return true;
  }
  return canOfferAccount(guest);
}

/**
 * Reads the two storage flags that decide whether this is a first run.
 *
 * `dashboardOnboardedStorageKey` is load-bearing and not redundant: it is
 * written by every install that has already played its first-launch dashboard
 * reveal, INCLUDING every install that predates this feature. Without it,
 * turning the flag on would greet a long-standing user with a marketing
 * takeover on their next launch.
 */
function readFirstRun(): boolean {
  return !(
    readFlag(desktopLandingSeenStorageKey) ||
    readFlag(dashboardOnboardedStorageKey)
  );
}

/**
 * ISS-5112 (PLN-1600 Step F) — the first-run landing, gated.
 *
 * Mounted ABOVE the app shell and REPLACING it, rather than layered over it.
 * Both matter:
 *
 * - Replacing, not overlaying, keeps the dashboard from running its reveal and
 *   arming the guided tour behind a cover the user has not dismissed yet.
 *   `useTourArming` only checks that its button has an `offsetParent`, which an
 *   obscured-but-mounted dashboard still has, so an overlay would burn the
 *   one-shot tour on a screen nobody is looking at.
 * - Above the shell, because this is a full-window screen with its own brand
 *   header. The existing `OnboardingOverlay` covers only the content viewport,
 *   so the same treatment there would frame a marketing hero inside the app's
 *   sidebar and topbar.
 *
 * The cost is that the renderer issues no local DB read while the landing is up,
 * which defers the collector import. That is bounded and designed for:
 * `RendererReadinessGates` fails open after `INITIAL_DASHBOARD_DATA_FAIL_OPEN_MS`
 * precisely because "a renderer sitting on cloud-hydrated screens never issues a
 * local DB read". The window reveal is unaffected — it gates on the React mount
 * signalled from `main.tsx`, above this gate.
 */
export function GuestLandingGate({ children }: { children: ReactNode }) {
  const flagEnabled = useFeatureFlagEnabled(
    DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY
  );
  const flagsResolved = useDesktopFeatureFlagsResolved();
  const [firstRun, setFirstRun] = useState(readFirstRun);

  const answer = useCallback(() => {
    writeFlag(desktopLandingSeenStorageKey);
    setFirstRun(false);
  }, []);

  // The flag snapshot arrives over an async IPC round-trip, but the window is
  // revealed on React mount — so without this a genuine first launch painted the
  // real sidebar/topbar/Sessions shell and then yanked it away when the flag
  // landed. A brand-new user's first frame of the product was the app they had
  // not been introduced to yet, which is the whole thing this screen exists to
  // prevent. Hold on the background instead; nothing hangs, because the reveal
  // gates on mount either way.
  //
  // Scoped to `firstRun`, so this costs exactly one launch per install and every
  // launch after it goes straight to the shell — flag on or off.
  if (firstRun && !flagsResolved) {
    return <GuestLandingHold />;
  }
  if (!isGuestLandingArmed({ flagEnabled, flagsResolved, firstRun })) {
    return <>{children}</>;
  }
  return <GuestLandingHost onAnswer={answer}>{children}</GuestLandingHost>;
}

/**
 * The armed half: reads auth, owns the sign-in step, and decides whether this
 * particular person still sees the landing. Mounted only once
 * {@link isGuestLandingArmed} says so, which is what keeps `useDesktopAuth` off
 * the tree on every flag-off launch.
 */
function GuestLandingHost({
  children,
  onAnswer,
}: {
  children: ReactNode;
  onAnswer: () => void;
}) {
  const guest = useGuestOnboarding();
  const { navigate } = useNavigation();
  const { cancelSignIn } = useDesktopAuth();
  const [signingIn, setSigningIn] = useState(false);

  const handleGetStarted = useCallback(() => {
    // The one forced route in the app. `DEFAULT_NAV_ID` is Sessions by design,
    // so without this the Dashboard — and therefore the guest tour that lives on
    // it — is unreachable on a real first launch. Every launch after this one
    // resolves to Sessions as before, because the install is no longer a first
    // run and the gate above never arms.
    navigate(hrefForNavId(NavId.Dashboard));
    onAnswer();
  }, [onAnswer, navigate]);

  const handleSignInDone = useCallback(() => {
    setSigningIn(false);
    onAnswer();
  }, [onAnswer]);

  const handleSignInBack = useCallback(() => {
    // `beginBrowserSignIn` is single-flight in the main process: backing out
    // while the system browser is open leaves that run in flight and the next
    // attempt is refused with "A sign-in is already in progress." with nothing on
    // screen to clear it. Best-effort, the same way `AccountDialog` and the
    // session-expired banner cancel.
    cancelSignIn().catch(() => undefined);
    setSigningIn(false);
  }, [cancelSignIn]);

  const handleSignIn = useCallback(() => setSigningIn(true), []);

  if (!shouldShowGuestLanding({ guest, signingIn })) {
    return <>{children}</>;
  }
  if (signingIn) {
    return (
      <GuestLandingSignIn
        onBack={handleSignInBack}
        onComplete={handleSignInDone}
      />
    );
  }
  return (
    <GuestLanding onGetStarted={handleGetStarted} onSignIn={handleSignIn} />
  );
}

/**
 * The landing's sign-in step: the REAL {@link DesktopOnboardingFlow} — loopback
 * OAuth through the system browser, the connect-GitHub grant and the sync-consent
 * tier — not a second auth path. The prototype's `AuthPanel` is scaffolding for
 * a browser this repo actually opens.
 *
 * It ships its own Card here (no `bare`), because unlike the dialog host there is
 * no panel around it to belong to. `Back` is the only way out for the same reason:
 * a full-window takeover has no Escape, no overlay click and no close control.
 */
export function GuestLandingSignIn({
  onBack,
  onComplete,
}: {
  onBack: () => void;
  onComplete: () => void;
}) {
  return (
    // `div`, not `main`, for the same reason as `GuestLanding` — the shell owns
    // the single `main` landmark and the gate enforces it statically.
    // `DesktopOnboardingFlow` brings its own heading, so there is nothing here to
    // name that it does not already name.
    <div className="relative h-screen overflow-y-auto bg-background">
      <GuestLandingDragStrip />
      {/*
        `min-h-full`, not `h-full`: this box is the only child of an
        `overflow-y-auto` scroller, and a child pinned to exactly the container's
        height makes `scrollHeight === clientHeight`, so no scrollbar is ever
        produced — `items-center` then splits the overflow above and below the
        viewport and the top of the card becomes unreachable. The setup step
        (connect-GitHub plus the three-tier consent picker) really does overflow,
        and the window has no `minHeight`.
      */}
      <div
        className={cn(
          "flex min-h-full items-center justify-center px-6 py-16",
          macStoplightClearance()
        )}
      >
        {/*
          The mark above the card, aligned to it — the composition the prototype's
          `AuthPanel` uses, and the reason this step no longer drops the brand on
          the way in from the hero.
        */}
        <div className="w-full max-w-[440px] space-y-4">
          <GuestLandingHeader className="px-1" />
          <DesktopOnboardingFlow
            // The honest framing for a door labelled "Already have an account?".
            authCopy={SIGN_IN_AUTH_COPY}
            // ISS-5489: this landing exists ONLY when `guest-onboarding` is on,
            // which is exactly when the post-auth takeover mounts — so consent is
            // always its job here, never this flow's. Statically true; no flag
            // read needed.
            consentOwnedElsewhere
            footer={
              <Button onClick={onBack} variant="ghost">
                <ArrowLeftIcon aria-hidden="true" />
                {BACK_LABEL}
              </Button>
            }
            onComplete={onComplete}
            // GitHub and Google only, matching the prototype's `AuthPanel`. The
            // magic-link form stays available everywhere else the flow is
            // hosted; this one screen is the returning-user door, and the
            // prototype settles what it offers.
            showEmail={false}
          />
        </div>
      </div>
    </div>
  );
}
