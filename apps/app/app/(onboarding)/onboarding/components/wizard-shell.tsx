"use client";

import type { OnboardingStep } from "@repo/api/src/types/onboarding";
import { Button } from "@repo/design-system/components/ui/button";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { ONBOARDING_STEPS } from "../lib/onboarding-constants";

type WizardShellProps = {
  readonly currentStep: OnboardingStep;
  readonly onBack?: () => void;
  readonly children: ReactNode;
};

export function WizardShell({
  currentStep,
  onBack,
  children,
}: WizardShellProps) {
  const currentIndex = ONBOARDING_STEPS.indexOf(currentStep);
  const showBack = currentIndex > 0;

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6">
      {/*
        The dots are decoration — shape and colour carrying "how far along am I",
        and nothing a screen reader can read. They stay hidden and the same fact
        is stated in words beside them, rather than bolting a role onto a div
        whose children are meaningless individually.
      */}
      <span className="sr-only">{`Step ${currentIndex + 1} of ${ONBOARDING_STEPS.length}`}</span>
      <div aria-hidden="true" className="flex items-center gap-2">
        {ONBOARDING_STEPS.map((step, index) => (
          <div
            className={`h-2 rounded-full transition-all ${
              index <= currentIndex
                ? "w-8 bg-primary"
                : "w-2 bg-muted-foreground/30"
            }`}
            key={step}
          />
        ))}
      </div>

      <Card className="w-full">
        <CardContent className="pt-0">
          {showBack && onBack && (
            <Button
              className="mb-4 -ml-2 gap-1 text-muted-foreground"
              onClick={onBack}
              size="sm"
              variant="ghost"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          )}
          {children}
        </CardContent>
      </Card>
    </div>
  );
}
