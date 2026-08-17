import {
  Alert,
  AlertDescription,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Card } from "@closedloop-ai/design-system/components/ui/card";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import { AccountSetupFlow } from "@repo/app/onboarding/components/account-setup-flow";
import {
  type AuthMethod,
  AuthMethods,
} from "@repo/app/onboarding/components/auth-methods";
import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";
import { AlertCircle } from "lucide-react";
import { type ReactNode, useCallback, useReducer, useState } from "react";
import type { DataSyncLevel } from "../../../shared/contracts";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  DesktopGitHubConnectState,
  useDesktopGitHubConnect,
} from "../branches/use-desktop-github-connect";
import { providerForMethod } from "./provider-for-method";
import { signInFailureMessage } from "./sign-in-failure-message";

/**
 * The renderer overlay steps of the unified first-launch onboarding flow
 * (PRD-532 M4). The host dashboard shell gates mounting this on the
 * not-yet-authenticated state.
 *
 * - `auth`   — {@link AuthMethods} (GitHub-first sign-in).
 * - `setup`  — {@link AccountSetupFlow}: the required Connect-GitHub grant (for
 *              Google/email sign-ups) then the sync-consent tier picker. A
 *              GitHub sign-up already granted the scoped connection, so
 *              `githubConnected` short-circuits the connect step.
 * - `done`   — the tier is persisted; the overlay unmounts itself.
 *
 * Every handler is wired to the real desktop flows — `beginSignIn()` (system
 * browser loopback OAuth), `connectGitHub()` (the GitHub App connect route),
 * and `setDataSyncLevel()` (the consolidated persisted setter). There are no
 * mocks or simulated round-trips (PRD-532 §12): the in-flight/loading/error
 * states are read from the real hook states.
 *
 * FEA-4055 / FEA-4103: the sync-consent step persists the ONE canonical data-sync
 * LEVEL through `setDataSyncLevel` — the SAME setter the Settings "Data & Sync"
 * tab uses — instead of writing `syncObservabilityTier` alone. `setDataSyncLevel`
 * deterministically derives every connectivity/sync boolean
 * (`transcriptSyncEnabled`, `cloudConnectionEnabled`, the observability tier)
 * from the level, so picking "Full transcripts" here actually enables transcript
 * upload end-to-end. Writing only the tier (the old path) left
 * `transcriptSyncEnabled` false, so a fresh user could pick Full and still keep
 * transcript bodies local — the divergence this consolidation removes.
 */
type FlowStep = "auth" | "setup" | "done";

type FlowState = {
  step: FlowStep;
  /** The sign-in method in flight, so AuthMethods can show its spinner. */
  pendingMethod: AuthMethod | null;
  /** A terminal sign-in failure to surface above the auth methods. */
  authError: string | null;
};

type FlowAction =
  | { type: "sign-in-start"; method: AuthMethod }
  | { type: "sign-in-success"; consentOwnedElsewhere: boolean }
  | { type: "sign-in-failure"; message: string }
  | { type: "finish" };

const INITIAL_STATE: FlowState = {
  step: "auth",
  pendingMethod: null,
  authError: null,
};

function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "sign-in-start":
      return { step: "auth", pendingMethod: action.method, authError: null };
    case "sign-in-success":
      // ISS-5489: when the post-auth consent takeover owns the question, this
      // flow must NOT also ask it. Signing in used to land here and render the
      // "Choose what syncs to the cloud" step while the blocking takeover mounted
      // on top of it — two consent surfaces at once, and (because both render the
      // same radio group) two that actively broke each other's selection.
      return {
        step: action.consentOwnedElsewhere ? "done" : "setup",
        pendingMethod: null,
        authError: null,
      };
    case "sign-in-failure":
      return {
        step: "auth",
        pendingMethod: null,
        authError: action.message,
      };
    case "finish":
      return { ...state, step: "done" };
    default:
      return state;
  }
}

/**
 * Props for {@link DesktopOnboardingFlow}. `onComplete` lets the host dashboard
 * shell dismiss the overlay once the flow finishes (tier persisted); the
 * component also self-latches to `done` so it stops rendering steps.
 */
type DesktopOnboardingFlowProps = {
  /**
   * Fired when the flow is finished with the user.
   *
   * `level` is the consent the flow persisted — and is ABSENT when the flow ended
   * at sign-in because the ISS-5489 takeover owns consent. Hosts use this to
   * dismiss themselves, so it must fire on BOTH endings: a host that only hears
   * about the consent ending would stay on screen forever behind the takeover.
   */
  onComplete?: (level?: SyncConsentLevel) => void;
  /**
   * ISS-5489: the post-auth consent takeover owns the sync question, so this
   * flow must end at sign-in instead of running its own consent step. Two
   * consent surfaces at once is not merely redundant — both render the same radio
   * group, and they broke each other's selection on screen.
   *
   * A PROP rather than a `useGuestOnboarding()` call inside this component, for
   * two reasons. It would be the third time a provider-requiring hook added to a
   * shared component broke every mount site without that provider (both
   * Storybook stories here, and four existing test suites, mount this flow bare).
   * And it is more honest: two of the three hosts know the answer STATICALLY —
   * the guest landing only exists when the flag is on, and the dashboard overlay
   * only renders when it is off — so making them ask a flag would be ceremony
   * around a constant.
   */
  consentOwnedElsewhere?: boolean;
  /**
   * ISS-5112 — render without the flow's own `Card`, for a host that already
   * provides the surface.
   *
   * The account dialog's `DialogContent` is a background, border, radius,
   * padding and shadow of its own; nesting a second panel inside it left two
   * components owning one surface and neither doing the whole job. The blocking
   * first-launch overlay passes nothing and keeps the `Card`, which is what
   * gives its error banner something opaque to sit on over the blurred
   * dashboard.
   */
  bare?: boolean;
  /**
   * Applied to whichever step's heading is on screen, so a host that owns the
   * surrounding surface (the account dialog) can name it from the visible
   * heading instead of a copy that goes stale when the flow advances.
   */
  headingId?: string;
  /**
   * ISS-5112 Step F — the auth step's wording, for a host whose entry point is
   * signing IN rather than signing up.
   *
   * The defaults below say "Create your Closedloop account", which is right for
   * every host that exists to convert someone: the blocking first-launch overlay
   * and the account dialog. The first-run landing has BOTH doors, and a returning
   * user who presses "Already have an account? Sign in" must not be answered with
   * an instruction to create the account they already have. Same loopback OAuth
   * behind it either way — only the framing differs, because only the framing
   * was ever wrong.
   */
  authCopy?: AuthStepCopy;
  /**
   * ISS-5112: whether the email method is offered alongside the two social
   * providers.
   *
   * EVERY door into this flow passes `false` — the landing's sign-in step, the
   * post-tour account dialog, and the blocking first-launch overlay — because
   * desktop has no magic-link path. An email pick opens the same loopback OAuth
   * as the others and the web side resolves the absent provider hint to GitHub,
   * so the button named an action it could not perform.
   *
   * The default stays `true` to mirror `AuthMethods`' own contract rather than
   * redefine it; Settings → Account still renders that component with the full
   * set.
   */
  showEmail?: boolean;
  /**
   * Rendered below the AUTH step only, inside the flow's own surface.
   *
   * For a host whose only way out is its own control — the first-run landing's
   * sign-in step is full-window, so it has no Escape, no overlay click and no
   * close button. A ghost button floating below a detached card reads as a
   * second-tier action rather than the way out of this one, so the exit belongs
   * on the card, the way the prototype's `AuthPanel` puts it in its `CardFooter`.
   *
   * **Auth step only, and that is load-bearing.** Rendering it under `setup` too
   * offered a "back" on a screen where backing out is no longer possible: by then
   * the browser round-trip has completed and the device is authenticated, so the
   * host's own guest test stops matching and the press drops the user into the
   * live app with the GitHub-connect and sync-consent steps silently abandoned.
   * Past auth this flow has exactly one way on — through it — the same as its
   * other two hosts.
   */
  footer?: ReactNode;
};

export type AuthStepCopy = {
  heading: string;
  /** The line under the heading. Overridden with it — the two have to agree. */
  body: string;
  emailCtaLabel: string;
};

export function DesktopOnboardingFlow({
  onComplete,
  bare = false,
  headingId,
  authCopy = DEFAULT_AUTH_COPY,
  showEmail = true,
  footer,
  consentOwnedElsewhere = false,
}: DesktopOnboardingFlowProps) {
  const auth = useDesktopAuth();
  const [state, dispatch] = useReducer(flowReducer, INITIAL_STATE);
  const [confirming, setConfirming] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const beginSignIn = auth.beginSignIn;
  const handleSelect = useCallback(
    async (method: AuthMethod) => {
      dispatch({ type: "sign-in-start", method });
      try {
        const result = await beginSignIn(providerForMethod(method));
        if (result.ok) {
          dispatch({
            type: "sign-in-success",
            consentOwnedElsewhere,
          });
          if (consentOwnedElsewhere) {
            // The flow is done the moment sign-in lands. Tell the host now — it
            // is what dismisses the landing/dialog so the takeover is not
            // rendered on top of a screen nobody can get rid of.
            onComplete?.();
          }
        } else {
          dispatch({
            type: "sign-in-failure",
            message: signInFailureMessage(result.reason),
          });
        }
      } catch {
        dispatch({
          type: "sign-in-failure",
          message: signInFailureMessage(),
        });
      }
    },
    [beginSignIn, consentOwnedElsewhere, onComplete]
  );

  const handleComplete = useCallback(
    async (level: SyncConsentLevel) => {
      setConfirming(true);
      setPersistError(null);
      try {
        // Route through the ONE consolidated setter (same as Settings → Data &
        // Sync). It derives `transcriptSyncEnabled` + the observability tier +
        // connectivity from the single level, so "Full transcripts" here truly
        // enables transcript upload — not just the observability tier. The
        // onboarding levels (`full`/`metadata`/`off`) ARE canonical
        // `DataSyncLevel` values, so the payload maps 1:1.
        await window.desktopApi.setDataSyncLevel(level satisfies DataSyncLevel);
        dispatch({ type: "finish" });
        onComplete?.(level);
      } catch {
        setPersistError("We couldn't save your sync choice. Please try again.");
      } finally {
        setConfirming(false);
      }
    },
    [onComplete]
  );

  if (state.step === "done") {
    return null;
  }

  const steps =
    state.step === "auth" ? (
      <AuthStep
        copy={authCopy}
        error={state.authError}
        headingId={headingId}
        onSelect={handleSelect}
        pendingMethod={state.pendingMethod}
        showEmail={showEmail}
      />
    ) : (
      <SetupStep
        confirming={confirming}
        headingId={headingId}
        onComplete={handleComplete}
        persistError={persistError}
      />
    );

  const body =
    footer && state.step === "auth" ? (
      <>
        {steps}
        <div className="mt-4">{footer}</div>
      </>
    ) : (
      steps
    );

  if (bare) {
    return body;
  }
  return (
    // Opaque surface so the error banner (and the flow) has something solid to
    // sit on: the host overlay blurs the live dashboard behind it, and the DS
    // error tint is translucent — without this the dashboard reads through.
    <Card className="mx-auto w-full max-w-[440px] px-6">{body}</Card>
  );
}

function AuthStep({
  onSelect,
  pendingMethod,
  error,
  headingId,
  copy,
  showEmail,
}: {
  onSelect: (method: AuthMethod) => void;
  pendingMethod: AuthMethod | null;
  error: string | null;
  headingId: string | undefined;
  copy: AuthStepCopy;
  showEmail: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <h1 className="font-semibold text-2xl tracking-tight" id={headingId}>
          {copy.heading}
        </h1>
        <p className="mx-auto mt-2 max-w-[400px] text-pretty text-muted-foreground text-sm leading-relaxed">
          {copy.body}
        </p>
      </div>
      {error ? <FlowError message={error} /> : null}
      <AuthMethods
        emailCtaLabel={copy.emailCtaLabel}
        onSelect={onSelect}
        pendingMethod={pendingMethod}
        showEmail={showEmail}
      />
      {/*
        PLN-1526 gap 4, adopted here. Every method on this panel hands off to the
        SYSTEM BROWSER — there is no in-Electron auth page — and the app then
        sits waiting on a loopback listener. Without saying so, the window
        appearing over the top reads as the app losing its place.
      */}
      <p className="text-center text-muted-foreground text-xs">
        Continuing opens your browser to finish signing in.
      </p>
    </div>
  );
}

function SetupStep({
  confirming,
  onComplete,
  persistError,
  headingId,
}: {
  confirming: boolean;
  onComplete: (level: SyncConsentLevel) => void;
  persistError: string | null;
  headingId: string | undefined;
}) {
  const githubStatus = useGitHubIntegrationStatus();
  const { connectState, connectGitHub } = useDesktopGitHubConnect({
    returnTo: "/",
  });
  const githubConnected = githubStatus.data?.connected === true;
  const connecting = connectState === DesktopGitHubConnectState.Pending;
  // Two identical red boxes stacked read as one error rendered twice. Surface a
  // single banner, latest-wins: a save failure supersedes a stale connect one.
  const setupError = persistError ?? connectErrorMessage(connectState);

  return (
    <div className="flex flex-col gap-4">
      {setupError ? <FlowError message={setupError} /> : null}
      <AccountSetupFlow
        confirming={confirming}
        connecting={connecting}
        githubConnected={githubConnected}
        headingId={headingId}
        onComplete={onComplete}
        onConnect={connectGitHub}
      />
    </div>
  );
}

function FlowError({ message }: { message: string }) {
  return (
    <Alert variant="error">
      <AlertCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/** The blocking first-launch overlay's wording: its entry point IS sign-up. */
const DEFAULT_AUTH_COPY: AuthStepCopy = {
  heading: "Create your Closedloop account",
  body: "Sign in to sync your local sessions, unlock team insights, and pick up where you left off across devices.",
  emailCtaLabel: "Create account with email",
};

/**
 * The landing's "Already have an account? Sign in" door — same flow, honest
 * framing.
 *
 * The body is overridden alongside the heading because the default is the
 * sign-UP pitch: under "Sign in to Closedloop" it opened "Sign in to sync your
 * local sessions…", saying the verb twice and then selling the product to
 * someone who already bought it. This one names whose account it wants, the way
 * the prototype's `AuthPanel` does, and leaves the browser hand-off to the line
 * the step already ends on.
 */
export const SIGN_IN_AUTH_COPY: AuthStepCopy = {
  heading: "Sign in to Closedloop",
  body: "Sign in with the account connected to your team workspace.",
  emailCtaLabel: "Email me a sign-in link",
};

/** Map a terminal connect-GitHub state to user-facing copy (none when idle). */
function connectErrorMessage(state: DesktopGitHubConnectState): string | null {
  if (state === DesktopGitHubConnectState.SignInRequired) {
    return "Please sign in first, then connect GitHub.";
  }
  if (state === DesktopGitHubConnectState.Failed) {
    return "GitHub connect could not be opened. Please try again.";
  }
  return null;
}
