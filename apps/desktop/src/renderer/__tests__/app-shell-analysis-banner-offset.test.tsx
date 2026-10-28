/**
 * ISS-10492 — the shell reserves the ambient analysis bar's height on the REAL
 * `SidebarInset`.
 *
 * The bar is `position: fixed`, so nothing beneath it moves on its own and this
 * offset is the only thing keeping the shell's content clear of it. An earlier
 * attempt at this coverage rendered its own stand-in for the inset, which meant
 * deleting the `style` from `App.tsx` left the suite 3/3 green — a test that
 * renders a substitute for the thing under test cannot fail. This renders the
 * production shell and reads the element `App` actually offsets; only the
 * PRODUCER (the onboarding dialog host, which owns the run) is stubbed, so it
 * can report a height without a full onboarding run.
 */
import { OnboardingAnalysisBanner } from "@repo/app/onboarding/components/onboarding-analysis-banner";
import { act, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAnalysisBannerHeightReporter } from "../components/onboarding/analysis-banner-offset";
import {
  ASYNC_SETTLE_TIMEOUT_MS,
  renderDesktopApp,
  setupAppShellSuite,
  TEST_TIMEOUT_MS,
} from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

const BAR_HEIGHT_PX = 36;
const SIDEBAR_INSET_SELECTOR = '[data-slot="sidebar-inset"]';

let reportHeight: ((height: number) => void) | undefined;

vi.mock(
  "../components/onboarding/desktop-guided-onboarding-dialog-host",
  () => ({
    DesktopGuidedOnboardingDialogHost: () => {
      const report = useAnalysisBannerHeightReporter();
      useEffect(() => {
        reportHeight = report;
      }, [report]);
      return (
        <OnboardingAnalysisBanner
          active
          analyzed={2}
          found={5}
          label="Processing agent history"
          onHeightChange={report}
          percent={40}
        />
      );
    },
  })
);

function sidebarInset(): HTMLElement {
  const inset = document.querySelector<HTMLElement>(SIDEBAR_INSET_SELECTOR);
  if (inset === null) {
    throw new Error("shell rendered no sidebar inset");
  }
  return inset;
}

describe("App shell analysis-bar offset", () => {
  setupAppShellSuite();

  it(
    "offsets the shell content by the bar's reported height, and only while it has one",
    async () => {
      renderDesktopApp("");
      await waitFor(() => expect(reportHeight).toBeTypeOf("function"), {
        timeout: ASYNC_SETTLE_TIMEOUT_MS,
      });

      // At rest the inset carries no inline margin at all: `variant="inset"`
      // gives it an `m-2`, and a literal `marginTop: 0` would override that top
      // margin and shift the whole shell whenever the bar is absent.
      expect(screen.getByRole("progressbar")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(sidebarInset().style.marginTop).toBe("");

      act(() => reportHeight?.(BAR_HEIGHT_PX));
      expect(sidebarInset().style.marginTop).toBe(`${BAR_HEIGHT_PX}px`);

      act(() => reportHeight?.(0));
      expect(sidebarInset().style.marginTop).toBe("");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "keeps returning-install content inside the offset while the bar is up",
    async () => {
      renderDesktopApp("");
      await waitFor(() => expect(reportHeight).toBeTypeOf("function"), {
        timeout: ASYNC_SETTLE_TIMEOUT_MS,
      });
      act(() => reportHeight?.(BAR_HEIGHT_PX));

      const inset = sidebarInset();
      expect(inset.style.marginTop).toBe(`${BAR_HEIGHT_PX}px`);
      const viewport = screen.getByTestId("desktop-content-viewport");
      expect(inset.contains(viewport)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});
