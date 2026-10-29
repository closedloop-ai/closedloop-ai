"use client";

import { OnboardingAnalysisBanner } from "@repo/app/onboarding/components/onboarding-analysis-banner"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { FIXTURE_SESSION_DISCOVERY } from "@repo/app/onboarding/lib/guided-onboarding-fixtures"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import {
  isAnalysisStatusPhase,
  useFtueProgress,
} from "./ftue-progress-context";

/**
 * The prototype's host for the promoted banner (ISS-8346).
 *
 * The component itself now lives in `@repo/app/onboarding`, where the product
 * renders it against real measurements. What stays here is the prototype's own
 * mock host: it reads the mock phase and progress, and takes its session counts
 * from the NAMED fixture rather than the `const TOTAL_SESSIONS = 270` that used
 * to sit in this file. That constant is exactly the invented number ISS-8678
 * removed from the wizard's copy, and a placeholder belongs in the register
 * where a reader can find it, not inlined beside the thing it fakes.
 */
export function AnalysisStatusBanner({
  onHeightChange,
}: {
  onHeightChange?: (height: number) => void;
} = {}) {
  const { phase, progress } = useFtueProgress();
  const active = isAnalysisStatusPhase(phase) && progress < 100;
  const found =
    FIXTURE_SESSION_DISCOVERY.status === "measured"
      ? FIXTURE_SESSION_DISCOVERY.sessionsFound
      : null;
  const analyzed =
    found === null
      ? null
      : Math.min(found, Math.round((found * progress) / 100));

  return (
    <OnboardingAnalysisBanner
      active={active}
      analyzed={analyzed}
      found={found}
      onHeightChange={onHeightChange}
      percent={progress}
    />
  );
}
