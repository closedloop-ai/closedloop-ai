"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

// The two wizard steps this scoped flow walks after auth. Production's wizard
// has more steps; the prototype models only what the requested flow renders.
export const WizardStep = {
  CreateTeam: "create-team",
  CreateProject: "create-project",
} as const;
export type WizardStep = (typeof WizardStep)[keyof typeof WizardStep];

export const wizardSteps: readonly WizardStep[] = [
  WizardStep.CreateTeam,
  WizardStep.CreateProject,
];

type WizardShellProps = {
  currentStep: WizardStep;
  onBack?: () => void;
  children: ReactNode;
};

export const WizardShell = ({
  currentStep,
  onBack,
  children,
}: WizardShellProps) => {
  const currentIndex = wizardSteps.indexOf(currentStep);
  const showBack = currentIndex > 0 && Boolean(onBack);

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-xl flex-col items-center gap-6">
        <div className="flex items-center gap-2" role="presentation">
          {wizardSteps.map((step, index) => (
            <div
              className={
                index <= currentIndex
                  ? "h-2 w-8 rounded-full bg-primary transition-all"
                  : "h-2 w-2 rounded-full bg-muted-foreground/30 transition-all"
              }
              key={step}
            />
          ))}
        </div>

        <Card className="w-full">
          <CardContent>
            {showBack && (
              <Button
                className="mb-4 -ml-2 gap-1 text-muted-foreground"
                onClick={onBack}
                size="sm"
                variant="ghost"
              >
                <ArrowLeftIcon className="size-4" />
                Back
              </Button>
            )}
            {children}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
