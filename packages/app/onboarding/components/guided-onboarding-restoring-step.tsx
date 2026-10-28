"use client";

import { DialogDescription } from "@repo/design-system/components/ui/dialog";
import { LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  GUIDED_ONBOARDING_STEP_BODY_CLASS,
  GuidedOnboardingPhaseHeading,
} from "./guided-onboarding-step-layout";

export function GuidedOnboardingRestoringStep({ brand }: { brand: ReactNode }) {
  return (
    <div className={GUIDED_ONBOARDING_STEP_BODY_CLASS}>
      <div className="h-7 w-fit">{brand}</div>
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-6 animate-spin text-muted-foreground"
        />
        <GuidedOnboardingPhaseHeading className="mt-4 font-semibold text-lg">
          Restoring your setup
        </GuidedOnboardingPhaseHeading>
        <DialogDescription className="mt-2 max-w-sm">
          Loading your saved onboarding progress.
        </DialogDescription>
      </div>
    </div>
  );
}
