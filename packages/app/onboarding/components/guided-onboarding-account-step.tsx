"use client";

import { OnboardingCtaId } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { Button } from "@repo/design-system/components/ui/button";
import { CheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useOnboardingCtaAnalytics } from "../hooks/use-onboarding-analytics";
import { createAccountEstablishedEvent } from "../lib/guided-onboarding-events";
import { type AuthMethod, AuthMethods } from "./auth-methods";
import {
  GuidedOnboardingBackButton,
  GuidedOnboardingPrimaryPlaceholder,
  GuidedOnboardingStepLayout,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";

export function GuidedOnboardingAccountStep({
  accountCreated,
  accountMethod,
  allowSkip,
  brand,
  onBack,
  onComplete,
  onSelect,
  onSignIn,
  onSkip,
  pendingMethod,
  signInError,
}: {
  accountCreated: boolean;
  accountMethod: AuthMethod | null;
  allowSkip: boolean;
  brand: ReactNode;
  onBack?: () => void;
  onComplete: () => void;
  onSelect: (method: AuthMethod, email?: string) => void;
  /** Routes an EXISTING account to the host's sign-in, not to completion. */
  onSignIn: () => void;
  onSkip: () => void;
  pendingMethod: AuthMethod | null;
  signInError: string | null;
}) {
  const accountMethodLabel = getAccountMethodLabel(accountMethod);
  const { captureCtaClick } = useOnboardingCtaAnalytics();

  return (
    <GuidedOnboardingStepLayout
      body={
        <div className="mx-auto mt-6 w-full max-w-sm">
          {accountCreated ? (
            <div className="flex items-center gap-3 border-y py-5">
              <CheckIcon className="size-5 text-success" />
              <div>
                <p className="font-medium text-sm">Account created</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  You’re signed in with your {accountMethodLabel}.
                </p>
              </div>
            </div>
          ) : (
            <>
              <AuthMethods
                emailCtaLabel="Create account with email"
                onSelect={(method, email) => {
                  // PRD-736 decision #14: an auth click with no subsequent
                  // step_completed[account] is an abandoned auth attempt,
                  // attributable per provider — invisible to completion events.
                  captureCtaClick({
                    ctaId: AUTH_METHOD_CTA_ID[method],
                    step: OnboardingPhase.Account,
                  });
                  onSelect(method, email);
                }}
                pendingMethod={pendingMethod}
              />
              {signInError ? (
                <p className="mt-3 text-destructive text-xs" role="alert">
                  {signInError}
                </p>
              ) : null}
            </>
          )}
        </div>
      }
      brand={brand}
      description={
        accountCreated ? (
          <p>
            You already have a Closedloop account, so there is nothing to create
            here. Continue to finish setting up your workspace.
          </p>
        ) : (
          <p>
            Session logs can get very large. Claude, Codex and Cursor all delete
            your session data regularly. Create a Closedloop account to securely
            backup your session data, analyze trends over time, and share what
            you learn with your team.
          </p>
        )
      }
      // ISS-11256: the eyebrow and the description switch on the same boolean
      // the body, footer and persistent actions already switch on. A reader who
      // already holds an account used to be told to create one, in the loudest
      // copy on the screen, with "Account created" as its quietest line.
      eyebrow={accountCreated ? "Your account" : "Create your account"}
      footer={
        <>
          <GuidedOnboardingBackButton onBack={onBack} />
          {accountCreated ? (
            <Button
              className="w-full sm:w-56"
              onClick={onComplete}
              size="lg"
              type="button"
            >
              Continue
            </Button>
          ) : (
            <GuidedOnboardingPrimaryPlaceholder />
          )}
        </>
      }
      persistentActions={
        accountCreated ? undefined : (
          <>
            <p className="mt-6 text-center text-muted-foreground text-xs leading-5">
              Already have an account?{" "}
              <button
                className="font-medium text-foreground hover:underline"
                onClick={() => {
                  captureCtaClick({
                    ctaId: OnboardingCtaId.SignIn,
                    step: OnboardingPhase.Account,
                  });
                  onSignIn();
                }}
                type="button"
              >
                Sign in
              </button>
            </p>
            {allowSkip ? (
              <div className="mt-3 flex justify-center">
                <Button
                  className="h-auto px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
                  onClick={onSkip}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Skip for now
                </Button>
              </div>
            ) : null}
          </>
        )
      }
      title="Learn what's working and share what you learn with your team."
    />
  );
}

const AUTH_METHOD_CTA_ID: Record<AuthMethod, OnboardingCtaId> = {
  email: OnboardingCtaId.AuthEmail,
  github: OnboardingCtaId.AuthGitHub,
  google: OnboardingCtaId.AuthGoogle,
};

function getAccountMethodLabel(method: AuthMethod | null): string {
  if (method === "github") {
    return "GitHub account";
  }
  if (method === "google") {
    return "Google account";
  }
  if (method === "email") {
    return "email account";
  }
  return "Closedloop account";
}

export function selectAccountStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingAccountStep> {
  return {
    accountCreated: source.accountCreated,
    accountMethod: source.accountMethod,
    allowSkip: source.allowSkipAccount,
    brand: source.brand,
    onBack: source.onBack,
    onComplete: source.onComplete,
    onSelect: (method, email) => dispatchAccountMethod(method, email, source),
    // Falls back to completion for Web, where completing IS the sign-in route.
    // Desktop supplies its own; see `onSignIn` on the dialog props.
    onSignIn: source.onSignIn ?? source.onComplete,
    onSkip: source.onSkipAccount ?? source.onComplete,
    pendingMethod: source.accountPendingMethod,
    signInError: source.accountSignInError,
  };
}

/**
 * Routes a chosen method to the host callback that owns it, falling back to
 * `onComplete` for a provider the host did not wire. Email is the one branch
 * that can do nothing: an empty address is not a choice to act on.
 */
function dispatchAccountMethod(
  method: AuthMethod,
  email: string | undefined,
  source: GuidedOnboardingPhaseSource
) {
  const event = createAccountEstablishedEvent(method);
  if (method === "github") {
    if (source.onContinueWithGitHub) {
      source.onContinueWithGitHub(event);
      return;
    }
    source.onComplete();
    return;
  }
  if (method === "google") {
    if (source.onContinueWithGoogle) {
      source.onContinueWithGoogle(event);
      return;
    }
    source.onComplete();
    return;
  }
  if (email) {
    if (source.onContinueWithEmail) {
      source.onContinueWithEmail(email, event);
      return;
    }
    source.onComplete();
  }
}
