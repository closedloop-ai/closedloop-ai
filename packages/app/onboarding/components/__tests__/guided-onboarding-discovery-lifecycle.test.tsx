// @vitest-environment jsdom
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  FIXTURE_SESSION_DISCOVERY,
  measuredAnalysisProgress,
} from "../../lib/guided-onboarding-fixtures";
import { OnboardingAnalysisProgressStatus } from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/app",
  mac: "https://downloads.test/app",
  windows: "https://downloads.test/app",
};

it("uses the host lifecycle for Continue at measured zero", () => {
  const onContinue = vi.fn();
  const props = {
    brand: "Closedloop",
    discovery: FIXTURE_SESSION_DISCOVERY,
    downloadHrefs: DOWNLOAD_HREFS,
    onComplete: vi.fn(),
    onContinue,
    open: true,
    phase: OnboardingPhase.SessionDiscovery,
    progress: measuredAnalysisProgress(0),
  };
  const { rerender } = render(
    <GuidedOnboardingDialog {...props} analysisStarted={false} />
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  rerender(<GuidedOnboardingDialog {...props} analysisStarted={true} />);
  const button = screen.getByRole("button", { name: "Continue" });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(onContinue).toHaveBeenCalledOnce();
});

it("preserves standalone hosts without a lifecycle override", () => {
  const props = {
    brand: "Closedloop",
    downloadHrefs: DOWNLOAD_HREFS,
    onComplete: vi.fn(),
    open: true,
    phase: OnboardingPhase.SessionDiscovery,
  };
  const { rerender } = render(
    <GuidedOnboardingDialog {...props} progress={measuredAnalysisProgress(0)} />
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  rerender(
    <GuidedOnboardingDialog
      {...props}
      discovery={FIXTURE_SESSION_DISCOVERY}
      progress={{ status: OnboardingAnalysisProgressStatus.Unknown }}
    />
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
});
