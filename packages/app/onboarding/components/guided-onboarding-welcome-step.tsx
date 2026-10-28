"use client";

import { OnboardingCtaId } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { Button } from "@repo/design-system/components/ui/button";
import { DialogDescription } from "@repo/design-system/components/ui/dialog";
import type { ComponentProps, ReactNode } from "react";
import { useOnboardingCtaAnalytics } from "../hooks/use-onboarding-analytics";
import { formatAnalyzedSessionSources } from "../lib/analyzed-session-sources";
import {
  GUIDED_ONBOARDING_STEP_BODY_CLASS,
  GUIDED_ONBOARDING_STEP_SCROLL_CLASS,
  GUIDED_ONBOARDING_STEP_SINGLE_ACTION_FOOTER_CLASS,
  GuidedOnboardingPhaseHeading,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";
import {
  DESKTOP_WELCOME_CTA_LABEL,
  WEB_WELCOME_CTA_LABEL,
} from "./guided-onboarding-welcome-copy";

export function GuidedOnboardingWelcomeStep({
  annotation,
  brand,
  desktopMode,
  onStart,
  privacyHref,
}: {
  annotation?: ReactNode;
  brand: ReactNode;
  desktopMode: boolean;
  onStart: () => void;
  privacyHref: string;
}) {
  const { captureCtaClick } = useOnboardingCtaAnalytics();
  const analyzedSources = formatAnalyzedSessionSources();
  return (
    <div className={GUIDED_ONBOARDING_STEP_BODY_CLASS}>
      <div className={GUIDED_ONBOARDING_STEP_SCROLL_CLASS}>
        <div className="h-7 w-fit">{brand}</div>
        <div className="mt-14 w-full">
          <p className="font-semibold text-primary text-xs uppercase tracking-wider">
            Welcome to Closedloop
          </p>
          <div className="relative">
            <GuidedOnboardingPhaseHeading className="mt-3 font-semibold text-3xl tracking-tight">
              Discover how you (and your team) build with AI.
            </GuidedOnboardingPhaseHeading>
            {annotation}
          </div>
          <DialogDescription className="mt-4 min-h-14 w-full text-base leading-7">
            <span className="block">
              <strong className="font-semibold text-foreground">
                What we do:
              </strong>{" "}
              Closedloop analyzes your {analyzedSources} sessions to show how
              agents are helping you build. Create a team account to share the
              agents, skills, and commands that work for you and learn from your
              teammates.
            </span>
            <span className="relative mt-4 block">
              <strong className="font-semibold text-foreground">
                Privacy:
              </strong>{" "}
              Only your {analyzedSources} sessions are analyzed. Closedloop can
              not see or analyze Chat conversations from ChatGPT or Claude. Your
              session logs and private data never leave your machine unless you
              choose to share them.{" "}
              <a
                className="text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground/60"
                href={privacyHref}
                onClick={() =>
                  captureCtaClick({
                    ctaId: OnboardingCtaId.PrivacyPolicy,
                    step: OnboardingPhase.Welcome,
                  })
                }
                rel="noreferrer"
                target="_blank"
              >
                Full Privacy Policy
              </a>
            </span>
          </DialogDescription>
        </div>
      </div>
      <div className={GUIDED_ONBOARDING_STEP_SINGLE_ACTION_FOOTER_CLASS}>
        <Button className="w-56" onClick={onStart} size="lg" type="button">
          {desktopMode ? DESKTOP_WELCOME_CTA_LABEL : WEB_WELCOME_CTA_LABEL}
        </Button>
      </div>
    </div>
  );
}

export function selectWelcomeStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingWelcomeStep> {
  return {
    annotation: source.annotations[OnboardingPhase.Welcome],
    brand: source.brand,
    desktopMode: source.desktopMode,
    onStart: source.onStart ?? source.onComplete,
    privacyHref: source.privacyHref,
  };
}
