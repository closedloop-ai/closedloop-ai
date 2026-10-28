// @vitest-environment jsdom

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  AccountProvider,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const ACCOUNT_ESTABLISHED_EMAIL_EVENT = {
  provider: AccountProvider.Email,
  type: OnboardingEvent.AccountEstablished,
} as const;
const ACCOUNT_ESTABLISHED_GITHUB_EVENT = {
  provider: AccountProvider.GitHub,
  type: OnboardingEvent.AccountEstablished,
} as const;
const ACCOUNT_ESTABLISHED_GOOGLE_EVENT = {
  provider: AccountProvider.Google,
  type: OnboardingEvent.AccountEstablished,
} as const;

describe("GuidedOnboardingDialog account events", () => {
  it("emits typed account events for GitHub, Google, and email methods", () => {
    const onContinueWithEmail = vi.fn();
    const onContinueWithGitHub = vi.fn();
    const onContinueWithGoogle = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onContinueWithEmail={onContinueWithEmail}
        onContinueWithGitHub={onContinueWithGitHub}
        onContinueWithGoogle={onContinueWithGoogle}
        open
        phase={OnboardingPhase.Account}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" })
    );
    expect(onContinueWithGitHub).toHaveBeenCalledWith(
      ACCOUNT_ESTABLISHED_GITHUB_EVENT
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" })
    );
    expect(onContinueWithGoogle).toHaveBeenCalledWith(
      ACCOUNT_ESTABLISHED_GOOGLE_EVENT
    );
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "builder@company.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create account with email" })
    );
    expect(onContinueWithEmail).toHaveBeenCalledWith(
      "builder@company.com",
      ACCOUNT_ESTABLISHED_EMAIL_EVENT
    );
  });

  it("keeps account deferral Desktop-only even when a Web host omits or opts into skip", () => {
    const { rerender } = render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        desktopMode={false}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.Account}
      />
    );

    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();

    rerender(
      <GuidedOnboardingDialog
        allowSkipAccount
        brand={<span>Closedloop.ai</span>}
        desktopMode={false}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.Account}
      />
    );

    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });
});
