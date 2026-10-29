// @vitest-environment jsdom

/**
 * What the Desktop welcome CTA is wired to.
 *
 * Pressing it posts `OnboardingEvent.Start`, which advances the run from
 * `Welcome` to `SessionDiscovery`, and nothing else. ISS-11146 observed that
 * this clause of PRD-689 had no executable test in either direction — nothing
 * asserted the button starts analysis and nothing asserted it does not — and
 * these cases close the wiring half of that gap:
 *
 *  - what the press does, carried through the real machine to the phase it
 *    lands on;
 *  - that the press routes to `onStart` ALONE — paired with the counterfactual
 *    that the same click DOES reach `onComplete` when no `onStart` is supplied,
 *    which is what proves the negative is observing a live wire rather than a
 *    prop the Welcome step never receives;
 *  - the Web label, which differs because Web opens account setup.
 *
 * The rendered label -> posted `OnboardingEvent.Start` binding is pinned
 * separately in `guided-onboarding-dialog-host.test.tsx`, which finds the button
 * by the same constant.
 *
 * These cases cover CTA wiring; Desktop collection-consent tests cover the
 * ISS-12523 requirement to hold analysis until an explicit policy is saved.
 */
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildOnboardingContext } from "../../lib/guided-onboarding-fixtures";
import { transitionOnboarding } from "../../lib/onboarding-transitions";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import {
  DESKTOP_WELCOME_CTA_LABEL,
  WEB_WELCOME_CTA_LABEL,
} from "../guided-onboarding-welcome-copy";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

function welcomeProps() {
  return {
    brand: <span>Closedloop.ai</span>,
    downloadHrefs: DOWNLOAD_HREFS,
    open: true,
    phase: OnboardingPhase.Welcome,
  } as const;
}

describe("the Desktop welcome CTA", () => {
  it("advances a Desktop run to the session-discovery step when pressed", () => {
    let phase: OnboardingPhase = OnboardingPhase.Welcome;
    const context = buildOnboardingContext({ host: OnboardingHost.Desktop });
    render(
      <GuidedOnboardingDialog
        {...welcomeProps()}
        desktopMode
        onComplete={vi.fn()}
        onStart={() => {
          const result = transitionOnboarding(
            {
              accountProvider: null,
              history: [],
              organizationEstablished: false,
              phase,
              resuming: false,
            },
            { type: OnboardingEvent.Start },
            context
          );
          if (result.status === "moved") {
            phase = result.state.phase;
          }
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );

    expect(phase).toBe(OnboardingPhase.SessionDiscovery);
  });

  it("routes the press to onStart alone, and to onComplete when there is no onStart", () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const { rerender } = render(
      <GuidedOnboardingDialog
        {...welcomeProps()}
        desktopMode
        onComplete={onComplete}
        onStart={onStart}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );

    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();

    // The positive control. `selectWelcomeStepProps` falls back to `onComplete`
    // when no `onStart` is supplied, so this click proves the spy above was on a
    // live wire: a CTA that called nothing at all would leave BOTH silent, and
    // the assertion above would still pass.
    rerender(
      <GuidedOnboardingDialog
        {...welcomeProps()}
        desktopMode
        onComplete={onComplete}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("leaves the Web CTA alone, because Web opens account setup", () => {
    render(
      <GuidedOnboardingDialog
        {...welcomeProps()}
        desktopMode={false}
        onComplete={vi.fn()}
        onStart={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: WEB_WELCOME_CTA_LABEL })
    ).not.toBeNull();
  });
});
