// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installButtonClickTracker } from "../../../shared/observability/button-click-tracker";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import type { GuidedOnboardingDialogProps } from "../guided-onboarding-types";
import { SYNC_CONSENT_LEVELS } from "../sync-consent";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const SAVE_FAILED = "We couldn't save your choice. Please try again.";

/**
 * Driven through the real dialog rather than the step in isolation, so the
 * phase selector's own wiring is exercised: a prop the selector forgets to pass
 * is the failure this suite is meant to catch, and a bare render of the step
 * would sail past it.
 */
function renderSyncStep(props: Partial<GuidedOnboardingDialogProps> = {}) {
  return render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={vi.fn()}
      open
      phase={OnboardingPhase.SyncPolicy}
      {...props}
    />
  );
}

function continueButton(): HTMLElement {
  return screen.getByRole("button", { name: "Continue" });
}

describe("guided onboarding sync step persistence (ISS-8346)", () => {
  it.each(SYNC_CONSENT_LEVELS)(
    "captures %s on onboarding Continue",
    async (level) => {
      const capture = vi.fn();
      const tracker = installButtonClickTracker({
        document: globalThis.document,
        capture,
        surface: Surface.Desktop,
        getPage: () => ({
          pageName: OnboardingAnalyticsPageName.Onboarding,
          entry: "/onboarding",
        }),
      });
      try {
        renderSyncStep({ syncLevel: level });
        await userEvent.click(continueButton());
        expect(capture).toHaveBeenCalledExactlyOnceWith(
          OnboardingAnalyticsEvent.ButtonClicked,
          expect.objectContaining({
            [OnboardingAnalyticsProperty.SyncChoiceSelected]: level,
          })
        );
      } finally {
        tracker.dispose();
      }
    }
  );

  it("hands the host the level the user actually chose", async () => {
    const onContinueFromSync = vi.fn();
    renderSyncStep({
      onContinueFromSync,
      syncLevel: DataSyncLevel.Metadata,
    });

    await userEvent.click(continueButton());

    // The level, not a re-read of the host's own copy: the step is what knows
    // which control is selected when the host left it uncontrolled.
    expect(onContinueFromSync).toHaveBeenCalledWith(DataSyncLevel.Metadata);
  });

  it("refuses to continue while a write is in flight", async () => {
    const onContinueFromSync = vi.fn();
    renderSyncStep({ onContinueFromSync, syncSaving: true });

    expect(continueButton().getAttribute("aria-busy")).toBe("true");
    await userEvent.click(continueButton());

    // A second write while the first is unresolved records the answer twice
    // and races its two replies.
    expect(onContinueFromSync).not.toHaveBeenCalled();
  });

  it("reports a failed write and keeps the choice retryable in place", async () => {
    const onContinueFromSync = vi.fn();
    renderSyncStep({ onContinueFromSync, syncError: SAVE_FAILED });

    expect(screen.getByRole("alert").textContent).toBe(SAVE_FAILED);

    // Dismissing the step on a failed write is what told a user their choice
    // was recorded when nothing had reached disk.
    await userEvent.click(continueButton());
    expect(onContinueFromSync).toHaveBeenCalledWith(DataSyncLevel.Full);
  });

  it("states no failure and no busy state when there is neither", () => {
    renderSyncStep();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(continueButton().getAttribute("aria-busy")).toBe("false");
  });

  it("cannot continue before a level is chosen", async () => {
    const onContinueFromSync = vi.fn();
    renderSyncStep({ onContinueFromSync, syncLevel: null });

    await userEvent.click(continueButton());

    expect(onContinueFromSync).not.toHaveBeenCalled();
  });
});
