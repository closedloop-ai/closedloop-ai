"use client";

import { OnboardingStep } from "@repo/api/src/types/onboarding";
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
  const showBack =
    currentStep !== OnboardingStep.Welcome &&
    currentStep !== OnboardingStep.Complete;

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6">
      {/* Progress dots */}
      <div className="flex items-center gap-2">
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
