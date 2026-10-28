// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { ORGANIZATION_LOGO_MAX_SIZE_BYTES } from "@repo/api/src/types/desktop-bootstrap";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { GITHUB_CONNECT_PROMPT_COPY } from "../../../github/lib/github-connect-copy";
import { createOrganizationReadyEvent } from "../../lib/guided-onboarding-events";
import {
  FIXTURE_GITHUB_CONNECTED,
  FIXTURE_GITHUB_DISCONNECTED,
  FIXTURE_GITHUB_RECONNECT,
  FIXTURE_ORGANIZATION_MEMBERS,
  FIXTURE_SESSION_DISCOVERY,
  measuredAnalysisProgress,
} from "../../lib/guided-onboarding-fixtures";
import { OnboardingDesktopSkipEligibility } from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import type { OrganizationLogoUploadHandler } from "../guided-onboarding-types";
import { DESKTOP_WELCOME_CTA_LABEL } from "../guided-onboarding-welcome-copy";

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const DOWNLOAD_CTA = /Download .* Desktop App/;
const DOWNLOAD_UNAVAILABLE_LINE = "Skipping this step isn't available yet.";
const CONNECT_GITHUB_CTA =
  GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Connect].ctaLabel;
const ORGANIZATION_READY_EVENT = createOrganizationReadyEvent();

describe("GuidedOnboardingDialog", () => {
  it("uses the canonical modal overlay, approved geometry, and locked dismissal", () => {
    const onComplete = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={onComplete}
        open
      />
    );

    expect(
      document.querySelector('[data-slot="dialog-overlay"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-slot="ftue-blocking-overlay"]')
    ).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("h-[min(680px,calc(100dvh-2rem))]")).toBe(
      true
    );
    expect(dialog.classList.contains("w-[min(900px,calc(100vw-2rem))]")).toBe(
      true
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("blocks the dashboard with a neutral state while progress is restored", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        restoring
      />
    );

    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Restoring your setup" })
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    ).toBeNull();
  });

  it("falls back to the restoring screen when open with no wizard phase", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
      />
    );

    // `open` and `phase` are independent props, so a host can mount before its
    // phase resolves. An empty body here would be a card with every dismissal
    // path prevented and no DialogTitle — inescapable, and nameless to a screen
    // reader. The restoring step is a real screen that still guesses no wizard
    // one: defaulting `phase` would reinstate the runtime fallthrough the
    // registry's exhaustiveness removes (ISS-8345).
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Restoring your setup" })
    ).not.toBeNull();
    expect(
      screen.queryByRole("heading", {
        name: "Discover how you (and your team) build with AI.",
      })
    ).toBeNull();
  });

  it("keeps no body mounted once closed with no wizard phase", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open={false}
      />
    );

    // Pins only that a closed dialog holds no body. It is deliberately NOT the
    // bound on the fallback above: jsdom runs no animations, so Radix unmounts
    // a closed dialog outright and this case passes whether or not the fallback
    // stays conditioned on `open` (verified by mutation). That bound, and WHICH
    // phase the exit fade carries, are the host's derivation and are pinned
    // where they are observable — the web-master prototype's
    // `useWebMasterOnboardingController exit-animation phase` suite.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("uses canonical sync values and copy", () => {
    const onSyncLevelChange = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onSyncLevelChange={onSyncLevelChange}
        open
        phase={OnboardingPhase.SyncPolicy}
        syncLevel={DataSyncLevel.Full}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Metadata only" }));
    expect(onSyncLevelChange).toHaveBeenCalledWith(DataSyncLevel.Metadata);
    expect(screen.getByRole("radio", { name: "Off" })).not.toBeNull();
  });

  it("keeps compact actions and progress content inside the dialog", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        discovery={FIXTURE_SESSION_DISCOVERY}
        downloadHrefs={DOWNLOAD_HREFS}
        onBack={vi.fn()}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.SessionDiscovery}
        progress={measuredAnalysisProgress(50)}
      />
    );

    const backButton = screen.getByRole("button", { name: "Back" });
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(backButton.classList.contains("w-full")).toBe(true);
    expect(continueButton.classList.contains("w-full")).toBe(true);
    expect(
      backButton.parentElement?.classList.contains("flex-col-reverse")
    ).toBe(true);
    expect(
      screen
        .getByRole("progressbar", { name: "Claude Code import progress" })
        .classList.contains("col-span-2")
    ).toBe(true);
  });

  it("uses the required canonical GitHub prompt without a skip action", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        // ISS-8352: the prompt is now conditional on a RESOLVED disconnection,
        // so the state has to be supplied. The assertion itself is unchanged —
        // the canonical screen still carries no Skip unless a host opts in.
        githubConnection={FIXTURE_GITHUB_DISCONNECTED}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.ConnectGitHub}
      />
    );

    expect(
      screen.getByRole("button", { name: "Continue with GitHub" })
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("asks for no GitHub connection until one is known to be missing", () => {
    // ISS-8352: a host that has not resolved the connection gets the pending
    // render. Prompting here asks a user who authorized GitHub at sign-in to
    // authorize it again, which is the defect the state split exists to stop.
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.ConnectGitHub}
      />
    );

    expect(
      screen.queryByRole("button", { name: CONNECT_GITHUB_CTA })
    ).toBeNull();
    expect(screen.getByText("Checking your GitHub connection.")).not.toBeNull();
    // Opt-in still governs the skip on this state, exactly as on the prompt.
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("confirms an established GitHub connection instead of prompting", () => {
    const onContinueFromGitHub = vi.fn();
    const onConnectGitHub = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        githubConnection={FIXTURE_GITHUB_CONNECTED}
        onComplete={vi.fn()}
        onConnectGitHub={onConnectGitHub}
        onContinueFromGitHub={onContinueFromGitHub}
        open
        phase={OnboardingPhase.ConnectGitHub}
      />
    );

    expect(
      screen.queryByRole("button", { name: CONNECT_GITHUB_CTA })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinueFromGitHub).toHaveBeenCalledTimes(1);
    expect(onConnectGitHub).not.toHaveBeenCalled();
  });

  it("offers the repair wording when the grant lapsed", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        githubConnection={FIXTURE_GITHUB_RECONNECT}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.ConnectGitHub}
      />
    );

    expect(
      screen.getByRole("heading", {
        name: "Reconnect GitHub to restore your PR and repo activity",
      })
    ).not.toBeNull();
  });

  it("renders the GitHub skip only for a host that opts into it", () => {
    const onSkipGitHub = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        githubConnection={FIXTURE_GITHUB_DISCONNECTED}
        onComplete={vi.fn()}
        onSkipGitHub={onSkipGitHub}
        open
        phase={OnboardingPhase.ConnectGitHub}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkipGitHub).toHaveBeenCalledTimes(1);
  });

  it("keeps the opted-in GitHub skip reachable while the state is unknown", () => {
    // A status read that never lands leaves the pending render with no forward
    // action, so withholding the skip there is a dead end for a host that
    // enabled deferral.
    const onSkipGitHub = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onSkipGitHub={onSkipGitHub}
        open
        phase={OnboardingPhase.ConnectGitHub}
      />
    );

    expect(screen.getByText("Checking your GitHub connection.")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: CONNECT_GITHUB_CTA })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkipGitHub).toHaveBeenCalledTimes(1);
  });

  it("locks both GitHub actions while a connect handoff is running", () => {
    const onConnectGitHub = vi.fn();
    const onSkipGitHub = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        githubConnecting
        githubConnection={FIXTURE_GITHUB_DISCONNECTED}
        onComplete={vi.fn()}
        onConnectGitHub={onConnectGitHub}
        onSkipGitHub={onSkipGitHub}
        open
        phase={OnboardingPhase.ConnectGitHub}
      />
    );

    const connect = screen.getByRole("button", {
      name: "Continue with GitHub",
    });
    expect(connect.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(connect);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onConnectGitHub).not.toHaveBeenCalled();
    expect(onSkipGitHub).not.toHaveBeenCalled();
  });

  it("renders a pre-existing Clerk organization logo without enabling fake upload", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        newOrganizationLogo={
          <span aria-label="Current Acme logo" role="img">
            A
          </span>
        }
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    expect(screen.getByLabelText("Current Acme logo")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Replace organization logo" })
    ).toBeDisabled();
    expect(
      screen.getByText("Logo upload is not available yet.")
    ).not.toBeNull();
  });

  it("keeps an omitted logo capability disabled with no fixture image", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    expect(screen.queryByLabelText("Current Acme logo")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Upload organization logo" })
    ).toBeDisabled();
    expect(
      screen.getByText("Logo upload is not available yet.")
    ).not.toBeNull();
  });

  it("rejects unsupported logo files before calling the upload handler", () => {
    const onUploadOrganizationLogo = vi.fn<OrganizationLogoUploadHandler>();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onUploadOrganizationLogo={onUploadOrganizationLogo}
        open
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    selectLogoFile(
      new File(["not an image"], "logo.txt", { type: "text/plain" })
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose an image file."
    );
    expect(onUploadOrganizationLogo).not.toHaveBeenCalled();
  });

  it("rejects oversized organization logos before calling the upload handler", () => {
    const onUploadOrganizationLogo = vi.fn<OrganizationLogoUploadHandler>();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onUploadOrganizationLogo={onUploadOrganizationLogo}
        open
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    selectLogoFile(
      new File(
        [new Uint8Array(ORGANIZATION_LOGO_MAX_SIZE_BYTES + 1)],
        "logo.png",
        {
          type: "image/png",
        }
      )
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose an image smaller than 10MB."
    );
    expect(onUploadOrganizationLogo).not.toHaveBeenCalled();
  });

  it("renders the logo only after the provider-backed upload confirms it", async () => {
    const user = userEvent.setup();
    const uploadFinished = createDeferred<void>();
    const selectedFile = organizationLogoFile();
    const onCreateOrganization = vi.fn();
    const uploadAttempt = vi.fn<OrganizationLogoUploadHandler>(
      () => uploadFinished.promise
    );

    render(
      <LogoUploadHarness
        onCreateOrganization={onCreateOrganization}
        onUpload={uploadAttempt}
      />
    );

    await user.upload(
      screen.getByLabelText("Organization logo file"),
      selectedFile
    );

    await waitFor(() =>
      expect(uploadAttempt).toHaveBeenCalledWith(selectedFile)
    );
    expect(screen.queryByLabelText("Provider-confirmed Acme logo")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create organization" })
    ).toBeDisabled();

    await act(async () => {
      uploadFinished.resolve();
      await uploadFinished.promise;
    });

    expect(
      await screen.findByLabelText("Provider-confirmed Acme logo")
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Create organization" })
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onCreateOrganization).not.toHaveBeenCalled();
  });

  it("retains confirmed upload state when the host does not refresh a logo prop", async () => {
    const user = userEvent.setup();
    const uploadFinished = createDeferred<void>();
    const selectedFile = organizationLogoFile();
    const onCreateOrganization = vi.fn();
    const uploadAttempt = vi.fn<OrganizationLogoUploadHandler>(
      () => uploadFinished.promise
    );

    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onCreateOrganization={onCreateOrganization}
        onUploadOrganizationLogo={uploadAttempt}
        open
        organizationName="AcmeCo"
        organizationSlug="acmeco"
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    await user.upload(
      screen.getByLabelText("Organization logo file"),
      selectedFile
    );

    await waitFor(() =>
      expect(uploadAttempt).toHaveBeenCalledWith(selectedFile)
    );
    expect(
      screen.getByRole("button", { name: "Create organization" })
    ).toBeDisabled();

    await act(async () => {
      uploadFinished.resolve();
      await uploadFinished.promise;
    });

    expect(await screen.findByText("Logo uploaded.")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Replace organization logo" })
    ).toBeEnabled();

    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(onCreateOrganization).toHaveBeenCalledWith(
      {
        name: "AcmeCo",
        slug: "acmeco",
      },
      ORGANIZATION_READY_EVENT
    );
  });

  it("keeps the prior Clerk logo visible when the upload handler rejects", async () => {
    const selectedFile = organizationLogoFile();
    const onUploadOrganizationLogo = vi
      .fn<OrganizationLogoUploadHandler>()
      .mockRejectedValue(new Error("Unauthorized"));
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        newOrganizationLogo={
          <span aria-label="Current Acme logo" role="img">
            A
          </span>
        }
        onComplete={vi.fn()}
        onUploadOrganizationLogo={onUploadOrganizationLogo}
        open
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    selectLogoFile(selectedFile);

    await waitFor(() =>
      expect(onUploadOrganizationLogo).toHaveBeenCalledWith(selectedFile)
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Logo upload failed. Try again."
    );
    expect(screen.getByLabelText("Current Acme logo")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();

    selectLogoFile(organizationLogoFile());

    await waitFor(() =>
      expect(onUploadOrganizationLogo).toHaveBeenCalledTimes(2)
    );
  });

  it("keeps staging disabled without a create callback that receives the file", () => {
    render(
      <GuidedOnboardingDialog
        allowStagedOrganizationLogo
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        organizationName="AcmeCo"
        organizationSlug="acmeco"
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    expect(
      screen.getByRole("button", { name: "Upload organization logo" })
    ).toBeDisabled();
    expect(
      screen.getByText("Logo upload is not available yet.")
    ).not.toBeNull();
  });

  it("passes a validated transient logo file to create-first hosts", () => {
    const selectedFile = organizationLogoFile();
    const onCreateOrganization = vi.fn();
    render(
      <GuidedOnboardingDialog
        allowStagedOrganizationLogo
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onCreateOrganization={onCreateOrganization}
        open
        organizationName="AcmeCo"
        organizationSlug="acmeco"
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    selectLogoFile(selectedFile);
    fireEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );

    expect(onCreateOrganization).toHaveBeenCalledWith(
      {
        logoFile: selectedFile,
        name: "AcmeCo",
        slug: "acmeco",
      },
      ORGANIZATION_READY_EVENT
    );
  });

  it("clears a staged transient logo when a replacement file is invalid", () => {
    const selectedFile = organizationLogoFile();
    const onCreateOrganization = vi.fn();
    render(
      <GuidedOnboardingDialog
        allowStagedOrganizationLogo
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onCreateOrganization={onCreateOrganization}
        open
        organizationName="AcmeCo"
        organizationSlug="acmeco"
        phase={OnboardingPhase.CreateOrganization}
      />
    );

    selectLogoFile(selectedFile);
    expect(
      screen.getByText(
        "logo.png will upload after the organization is created."
      )
    ).not.toBeNull();

    selectLogoFile(
      new File(["not an image"], "logo.txt", { type: "text/plain" })
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose an image file."
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );

    expect(onCreateOrganization).toHaveBeenCalledWith(
      {
        name: "AcmeCo",
        slug: "acmeco",
      },
      ORGANIZATION_READY_EVENT
    );
  });

  it("drops a staged transient logo when staging capability is revoked", async () => {
    const user = userEvent.setup();
    const selectedFile = organizationLogoFile();
    const onCreateOrganization = vi.fn();
    render(
      <StagedLogoRevocationHarness
        onCreateOrganization={onCreateOrganization}
      />
    );

    selectLogoFile(selectedFile);
    expect(
      screen.getByText(
        "logo.png will upload after the organization is created."
      )
    ).not.toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Disable logo upload" })
    );

    expect(
      await screen.findByText("Logo upload is not available yet.")
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Upload organization logo" })
    ).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );

    expect(onCreateOrganization).toHaveBeenCalledWith(
      {
        name: "AcmeCo",
        slug: "acmeco",
      },
      ORGANIZATION_READY_EVENT
    );
  });

  it("lets the host point the legal links at its own routes", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.ChooseOrganization}
        privacyHref="/p/web-master/legal/privacy"
        termsHref="/p/web-master/legal/terms"
      />
    );

    expect(
      screen.getByRole("link", { name: "Privacy" }).getAttribute("href")
    ).toBe("/p/web-master/legal/privacy");
    expect(
      screen.getByRole("link", { name: "Terms" }).getAttribute("href")
    ).toBe("/p/web-master/legal/terms");
  });

  it("emits the invite in the same tick it confirms it was sent", () => {
    const onInviteTeam = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        members={FIXTURE_ORGANIZATION_MEMBERS}
        onComplete={vi.fn()}
        onInviteTeam={onInviteTeam}
        open
        phase={OnboardingPhase.InviteTeam}
      />
    );

    fireEvent.change(screen.getByLabelText("Work emails"), {
      target: { value: "builder@company.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    // The confirmation and the request must land together: a deferred request
    // let an unmount cancel it while "1 email sent" stayed on screen.
    expect(screen.getByText("1 email sent")).not.toBeNull();
    expect(onInviteTeam).toHaveBeenCalledWith(["builder@company.com"]);
  });

  it("links the download CTA to the host-supplied installer, not a baked-in release", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.DownloadDesktop}
      />
    );

    // Which OS is detected is environment-dependent and covered separately;
    // the contract here is that the href comes from the host-supplied map and
    // that no release URL is baked into the shared step.
    const cta = screen.getByRole("link", { name: DOWNLOAD_CTA });
    expect(Object.values(DOWNLOAD_HREFS)).toContain(cta.getAttribute("href"));
    expect(document.body.innerHTML).not.toContain("github.com");
  });

  it("treats an unsupplied skip eligibility as unmeasured, not as a denial", () => {
    // The dialog owns ONE default for this prop. Asserting only "no Skip" would
    // pass just as well if omission wrongly resolved to `required`, because both
    // arms hide the button — so this asserts the line that only the unmeasured
    // arm renders.
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.DownloadDesktop}
      />
    );

    expect(screen.getByText(DOWNLOAD_UNAVAILABLE_LINE)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("forwards a supplied eligibility through to the download step", () => {
    // The positive control for the case above. Types cannot catch this one:
    // `allowSkipAccount` sits beside `desktopSkipEligibility` in the same
    // destructure, so a forward wired to the wrong prop still compiles.
    const onSkipDownload = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        desktopSkipEligibility={OnboardingDesktopSkipEligibility.Eligible}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onSkipDownload={onSkipDownload}
        open
        phase={OnboardingPhase.DownloadDesktop}
      />
    );

    expect(screen.queryByText(DOWNLOAD_UNAVAILABLE_LINE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkipDownload).toHaveBeenCalledOnce();
  });
});

function LogoUploadHarness({
  onCreateOrganization = vi.fn(),
  onUpload,
}: {
  onCreateOrganization?: (organization: {
    logoFile?: File;
    name: string;
    slug: string;
  }) => void;
  onUpload: OrganizationLogoUploadHandler;
}) {
  const [logo, setLogo] = useState<ReactNode>(null);
  return (
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      newOrganizationLogo={logo}
      onComplete={vi.fn()}
      onCreateOrganization={onCreateOrganization}
      onUploadOrganizationLogo={async (file) => {
        await onUpload(file);
        setLogo(
          <span aria-label="Provider-confirmed Acme logo" role="img">
            A
          </span>
        );
      }}
      open
      organizationName="AcmeCo"
      organizationSlug="acmeco"
      phase={OnboardingPhase.CreateOrganization}
    />
  );
}

function StagedLogoRevocationHarness({
  onCreateOrganization,
}: {
  onCreateOrganization: (organization: {
    logoFile?: File;
    name: string;
    slug: string;
  }) => void;
}) {
  const [allowStagedLogo, setAllowStagedLogo] = useState(true);
  return (
    <GuidedOnboardingDialog
      allowStagedOrganizationLogo={allowStagedLogo}
      annotations={{
        [OnboardingPhase.CreateOrganization]: (
          <button onClick={() => setAllowStagedLogo(false)} type="button">
            Disable logo upload
          </button>
        ),
      }}
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={vi.fn()}
      onCreateOrganization={onCreateOrganization}
      open
      organizationName="AcmeCo"
      organizationSlug="acmeco"
      phase={OnboardingPhase.CreateOrganization}
    />
  );
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously by the promise executor before this helper returns.
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function organizationLogoFile() {
  return new File(["logo"], "logo.png", { type: "image/png" });
}

function selectLogoFile(file: File) {
  fireEvent.change(screen.getByLabelText("Organization logo file"), {
    target: { files: [file] },
  });
}
