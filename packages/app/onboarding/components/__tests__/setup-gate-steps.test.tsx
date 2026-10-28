// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolveSetupGate } from "../../lib/first-user-setup-gate";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import type { GuidedOnboardingDialogProps } from "../guided-onboarding-types";
import { SetupGateStepList, SyncPolicyGateNotice } from "../setup-gate-steps";

// Host-supplied words (the components carry none of their own), deliberately
// unlike any shipped string so an assertion can only pass on what was passed.
const COPY = {
  downloaded: "test-copy: download acknowledged",
  explanation: "test-copy: why sessions are not here yet",
  listLabel: "test-copy: steps",
  stepComplete: "test-copy: complete",
  stepIncomplete: "test-copy: incomplete",
} as const;

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

const DOWNLOADED_UNSET = resolveSetupGate({
  desktopAppDownloaded: true,
  membership: OrganizationMembership.FirstUser,
  syncPolicy: null,
});

function renderDialog(props: Partial<GuidedOnboardingDialogProps>) {
  return render(
    <GuidedOnboardingDialog
      brand={<span>Closedloop.ai</span>}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={vi.fn()}
      open
      {...props}
    />
  );
}

function stepRows() {
  const list = screen.getByRole("list", { name: COPY.listLabel });
  return within(list).getAllByRole("listitem");
}

describe("SetupGateStepList (ISS-12363)", () => {
  it("states each step's state in words, not only by glyph", () => {
    render(<SetupGateStepList copy={COPY} gate={DOWNLOADED_UNSET} />);
    const [download, sync] = stepRows();
    expect(download).toHaveTextContent("Download Desktop");
    expect(download).toHaveTextContent(COPY.stepComplete);
    expect(download).not.toHaveAttribute("aria-current");
    expect(sync).toHaveTextContent("Choose session sync");
    expect(sync).toHaveTextContent(COPY.stepIncomplete);
    expect(sync).toHaveAttribute("aria-current", "step");
  });

  it("marks an explicit Off as done", () => {
    render(
      <SetupGateStepList
        copy={COPY}
        gate={resolveSetupGate({
          desktopAppDownloaded: true,
          membership: OrganizationMembership.FirstUser,
          syncPolicy: DataSyncLevel.Off,
        })}
      />
    );
    const [, sync] = stepRows();
    expect(sync).toHaveTextContent(COPY.stepComplete);
    expect(sync).not.toHaveAttribute("aria-current");
  });
});

describe("the sync step's gate notice (ISS-12363)", () => {
  it("says the download happened above the picker on the sync step", () => {
    renderDialog({
      phase: OnboardingPhase.SyncPolicy,
      stepNotices: {
        [OnboardingPhase.SyncPolicy]: (
          <SyncPolicyGateNotice copy={COPY} gate={DOWNLOADED_UNSET} />
        ),
      },
      syncLevel: null,
    });
    expect(screen.getByText(COPY.downloaded)).toBeVisible();
    expect(screen.getByText(COPY.explanation)).toBeVisible();
    // Unset means nothing is pre-chosen for the reader, so Continue waits.
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("does not claim a download that has not happened", () => {
    render(
      <SyncPolicyGateNotice
        copy={COPY}
        gate={resolveSetupGate({
          desktopAppDownloaded: false,
          membership: OrganizationMembership.FirstUser,
          syncPolicy: null,
        })}
      />
    );
    expect(screen.queryByText(COPY.downloaded)).toBeNull();
    expect(screen.getByText(COPY.explanation)).toBeVisible();
  });

  it("renders no gate content when the host supplies none", () => {
    // Every production host today: the step must render exactly as before.
    renderDialog({ phase: OnboardingPhase.SyncPolicy, syncLevel: null });
    expect(screen.queryByText(COPY.downloaded)).toBeNull();
    expect(screen.getByRole("radiogroup")).toBeVisible();
  });
});

describe("SetupGateStepList completedOnly (ISS-12363)", () => {
  it("lists only finished steps, so the card's action names the open one once", () => {
    render(
      <SetupGateStepList completedOnly copy={COPY} gate={DOWNLOADED_UNSET} />
    );
    const rows = stepRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Download Desktop");
    expect(rows[0]).toHaveTextContent(COPY.stepComplete);
  });

  it("renders nothing while no step is finished", () => {
    render(
      <SetupGateStepList
        completedOnly
        copy={COPY}
        gate={resolveSetupGate({
          desktopAppDownloaded: false,
          membership: OrganizationMembership.ExistingMember,
          syncPolicy: null,
        })}
      />
    );
    expect(screen.queryByRole("list", { name: COPY.listLabel })).toBeNull();
  });
});
