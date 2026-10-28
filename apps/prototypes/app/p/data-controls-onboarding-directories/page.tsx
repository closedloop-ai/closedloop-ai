"use client";

import { GuidedOnboardingDirectoryStepDemo } from "@repo/app/onboarding/components/guided-onboarding-directory-step-demo";
import { mockProps } from "./mock";

const DataControlsOnboardingDirectoriesPrototypePage = () => (
  <main>
    <GuidedOnboardingDirectoryStepDemo {...mockProps} />
  </main>
);

export default DataControlsOnboardingDirectoriesPrototypePage;
