"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { DialogDescription } from "@repo/design-system/components/ui/dialog";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { GitHubLogo } from "../../shared/feature-flags/github-logo";
import {
  ConnectGitHubError,
  ConnectGitHubPrompt,
} from "./connect-github-prompt";
import {
  type OnboardingGitHubConnection,
  UNKNOWN_GITHUB_CONNECTION,
} from "./guided-onboarding-data";
import {
  GUIDED_ONBOARDING_STEP_BODY_CLASS,
  GUIDED_ONBOARDING_STEP_FOOTER_CLASS,
  GUIDED_ONBOARDING_STEP_SCROLL_CLASS,
  GuidedOnboardingBackButton,
  GuidedOnboardingPhaseHeading,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";

/**
 * The PR-attribution step (ISS-8352).
 *
 * It renders exactly one of three things, and which one is decided upstream by
 * `../lib/onboarding-github-connection.ts` — this component classifies nothing
 * itself. The split matters because `unknown` and `disconnected` used to be the
 * same render: a step that could not yet tell whether GitHub was connected
 * showed the Connect prompt anyway, which asks a user who authorized GitHub at
 * sign-in to authorize it again.
 *
 * The connect/reconnect wording is `ConnectGitHubPrompt`'s and stays there —
 * it has been wrong in both directions before (see that file), and the
 * read-only grants assurance it renders is the whole point of the screen.
 */
export function GuidedOnboardingGitHubStep({
  brand,
  connecting = false,
  connectError = null,
  connection = UNKNOWN_GITHUB_CONNECTION,
  onBack,
  onConnect,
  onContinue,
  onSkip,
}: {
  brand: ReactNode;
  /** Controlled in-flight state: a connect handoff is running. Host-owned. */
  connecting?: boolean;
  connection?: OnboardingGitHubConnection;
  /**
   * Why the last connect handoff could not be opened, or `null`. Host-owned:
   * this step reports the outcome, it does not classify it (ISS-10990).
   */
  connectError?: string | null;
  onBack?: () => void;
  onConnect: () => void;
  /**
   * Advances past an already-connected step. Required, not optional: the only
   * fallback available here is `onConnect`, and a Continue that silently starts
   * a connect handoff is a control that does not do what it says.
   */
  onContinue: () => void;
  /** Defers GitHub authorization when the host offers optional onboarding. */
  onSkip?: () => void;
}) {
  const copy = STEP_COPY[connection.status];
  return (
    <div className={GUIDED_ONBOARDING_STEP_BODY_CLASS}>
      <div className={GUIDED_ONBOARDING_STEP_SCROLL_CLASS}>
        <div className="h-7 w-fit">{brand}</div>
        <GuidedOnboardingPhaseHeading className="sr-only">
          {copy.title}
        </GuidedOnboardingPhaseHeading>
        <DialogDescription className="sr-only">
          {copy.description}
        </DialogDescription>
        <div className="mt-14 flex flex-1 items-start">
          <GuidedOnboardingGitHubBody
            connectError={connectError}
            connecting={connecting}
            connection={connection}
            onConnect={onConnect}
            onContinue={onContinue}
            onSkip={onSkip}
          />
        </div>
      </div>
      <div className={GUIDED_ONBOARDING_STEP_FOOTER_CLASS}>
        <GuidedOnboardingBackButton onBack={onBack} />
      </div>
    </div>
  );
}

function GuidedOnboardingGitHubBody({
  connectError,
  connecting,
  connection,
  onConnect,
  onContinue,
  onSkip,
}: {
  connectError: string | null;
  connecting: boolean;
  connection: OnboardingGitHubConnection;
  onConnect: () => void;
  onContinue: () => void;
  onSkip?: () => void;
}) {
  if (connection.status === "connected") {
    return <GuidedOnboardingGitHubConnected onContinue={onContinue} />;
  }
  if (connection.status === "unknown") {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col">
        <GuidedOnboardingGitHubChecking />
        {/* ISS-10990: the failure survives a status read that has not landed.
            The connect handoff finishes in the BROWSER, so the reader returns to
            a focus-triggered re-read — and a read that folds to `null` puts this
            step back on `unknown`. Dropping the message here would hide the
            refused handoff behind a spinner, which is the same silence this
            ticket exists to remove. */}
        <ConnectGitHubError error={connectError} />
        <GuidedOnboardingGitHubSkip connecting={connecting} onSkip={onSkip} />
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-md flex-col">
      <ConnectGitHubPrompt
        action={connection.action}
        connecting={connecting}
        error={connectError}
        onConnect={onConnect}
      />
      <GuidedOnboardingGitHubSkip connecting={connecting} onSkip={onSkip} />
    </div>
  );
}

/**
 * The opt-in deferral control, rendered on every state that has no forward
 * action of its own. `unknown` needs it as much as `disconnected` does: a
 * status read that never lands leaves the step showing a spinner whose only
 * exit is Back, which is a dead end for a host that explicitly enabled
 * deferral (codex, ISS-8352 review).
 */
function GuidedOnboardingGitHubSkip({
  connecting,
  onSkip,
}: {
  connecting: boolean;
  onSkip?: () => void;
}) {
  if (!onSkip) {
    return null;
  }
  return (
    <div className="mt-3 flex justify-center">
      <Button
        className="h-auto px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
        disabled={connecting}
        onClick={onSkip}
        size="sm"
        type="button"
        variant="ghost"
      >
        Skip for now
      </Button>
    </div>
  );
}

function GuidedOnboardingGitHubConnected({
  onContinue,
}: {
  onContinue: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      <GitHubLogo className="size-6" />
      <h1 className="mt-4 font-semibold text-2xl tracking-tight">
        GitHub connected
      </h1>
      <p className="mx-auto mt-2 max-w-sm text-pretty text-muted-foreground text-sm leading-relaxed">
        Closedloop can attribute your pull request and repository activity to
        you.
      </p>
      <Button
        className="mt-5 w-full"
        onClick={onContinue}
        size="lg"
        type="button"
      >
        <CheckIcon />
        Continue
      </Button>
    </div>
  );
}

/**
 * The honest pending render. Not the Connect prompt: asking is a claim that the
 * user is disconnected, and at this point nobody has established that.
 */
function GuidedOnboardingGitHubChecking() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      <LoaderCircleIcon
        aria-hidden="true"
        className="size-6 animate-spin text-muted-foreground"
      />
      <p className="mt-4 text-muted-foreground text-sm">
        Checking your GitHub connection.
      </p>
    </div>
  );
}

/** The dialog's accessible name and description, per rendered state. */
const STEP_COPY: Record<
  OnboardingGitHubConnection["status"],
  { description: string; title: string }
> = {
  connected: {
    description: "Your GitHub account is connected.",
    title: "GitHub connected",
  },
  disconnected: {
    description: "Connect your GitHub account to continue.",
    title: "Connect GitHub",
  },
  unknown: {
    description: "Checking whether your GitHub account is connected.",
    title: "Checking your GitHub connection",
  },
};

export function selectGitHubStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingGitHubStep> {
  return {
    brand: source.brand,
    connectError: source.githubConnectError,
    connecting: source.githubConnecting,
    connection: source.githubConnection,
    onBack: source.onBack,
    onConnect: source.onConnectGitHub ?? source.onComplete,
    onContinue: source.onContinueFromGitHub ?? source.onComplete,
    // The host owns whether this run offers deferral.
    onSkip: source.onSkipGitHub,
  };
}
