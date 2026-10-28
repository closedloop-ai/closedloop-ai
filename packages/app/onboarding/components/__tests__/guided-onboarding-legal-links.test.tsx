// @vitest-environment jsdom

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGAL_PRIVACY_PATH,
  LEGAL_TERMS_PATH,
} from "../../../shared/lib/legal-links";
import { DEFAULT_WEB_ORIGIN } from "../../lib/legal-links";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";

const CONFIGURED_WEB_ORIGIN = "https://web.test";
const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;
const originalWebUrl = process.env.NEXT_PUBLIC_WEB_URL;

function setWebUrl(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_WEB_URL");
    return;
  }
  process.env.NEXT_PUBLIC_WEB_URL = value;
}

function renderWelcomeStep(): void {
  render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={vi.fn()}
      open
      phase={OnboardingPhase.Welcome}
    />
  );
}

/**
 * ISS-11397. The default is what ships: no host — not `apps/app`, not the
 * desktop renderer — passes `privacyHref`, so a root-relative default is a 404
 * on both. In `apps/app` it resolves against `app.closedloop.ai`, which does not
 * serve the marketing route; in the desktop renderer it resolves against the
 * `app://` scheme, which serves bundled assets only. That is the regression this
 * file exists to stop coming back, so it asserts the rendered ANCHOR on the very
 * first onboarding step rather than the helper alone.
 */
describe("guided onboarding legal links", () => {
  afterEach(() => {
    setWebUrl(originalWebUrl);
  });

  it("resolves the welcome step's privacy link against NEXT_PUBLIC_WEB_URL", () => {
    setWebUrl(CONFIGURED_WEB_ORIGIN);

    renderWelcomeStep();

    expect(
      screen
        .getByRole("link", { name: "Full Privacy Policy" })
        .getAttribute("href")
    ).toBe(`${CONFIGURED_WEB_ORIGIN}${LEGAL_PRIVACY_PATH}`);
  });

  it("tolerates a trailing slash on the configured origin", () => {
    setWebUrl(`${CONFIGURED_WEB_ORIGIN}/`);

    renderWelcomeStep();

    expect(
      screen
        .getByRole("link", { name: "Full Privacy Policy" })
        .getAttribute("href")
    ).toBe(`${CONFIGURED_WEB_ORIGIN}${LEGAL_PRIVACY_PATH}`);
  });

  it("falls back to the production marketing origin when the bundle carries no web url", () => {
    // The desktop renderer's case: `NEXT_PUBLIC_WEB_URL` is a Next inline and
    // the Vite renderer build defines nothing for it, so the fallback is the
    // href that actually ships there.
    setWebUrl(undefined);

    renderWelcomeStep();

    expect(
      screen
        .getByRole("link", { name: "Full Privacy Policy" })
        .getAttribute("href")
    ).toBe(`${DEFAULT_WEB_ORIGIN}${LEGAL_PRIVACY_PATH}`);
  });

  it("opens the privacy link in a new tab with a safe rel", () => {
    setWebUrl(CONFIGURED_WEB_ORIGIN);

    renderWelcomeStep();

    const link = screen.getByRole("link", { name: "Full Privacy Policy" });

    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("resolves the choose-organization step's legal links the same way", () => {
    setWebUrl(CONFIGURED_WEB_ORIGIN);

    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.ChooseOrganization}
      />
    );

    expect(
      screen.getByRole("link", { name: "Privacy" }).getAttribute("href")
    ).toBe(`${CONFIGURED_WEB_ORIGIN}${LEGAL_PRIVACY_PATH}`);
    expect(
      screen.getByRole("link", { name: "Terms" }).getAttribute("href")
    ).toBe(`${CONFIGURED_WEB_ORIGIN}${LEGAL_TERMS_PATH}`);
  });
});
