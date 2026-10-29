import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import {
  FIXTURE_ACCOUNT,
  FIXTURE_DOWNLOAD_HREFS,
  FIXTURE_GITHUB_DISCONNECTED,
  FIXTURE_JOINABLE_ORGANIZATION,
  FIXTURE_ORGANIZATION_MEMBERS,
  FIXTURE_ORGANIZATION_NAME,
  FIXTURE_ORGANIZATION_SLUG,
  FIXTURE_SESSION_DISCOVERY,
  measuredAnalysisProgress,
} from "../lib/guided-onboarding-fixtures";
import { OnboardingDesktopSkipEligibility } from "./guided-onboarding-data";
import { GUIDED_ONBOARDING_PHASES } from "./guided-onboarding-phase-registry";
import type {
  GuidedOnboardingPhaseSource,
  WizardPhase,
} from "./guided-onboarding-types";

/**
 * One phase, mounted from its own registry entry with no wizard shell around
 * it. This is the rendered half of ISS-8345's "each phase can be mounted
 * without editing the shell": `GuidedOnboardingDialog` is absent from this
 * file entirely, so a phase that only worked through the shell's dispatch
 * could not appear here.
 *
 * The sibling `guided-onboarding-dialog.stories.tsx` is the opposite view and
 * stays that way — it drives the real wizard through a stateful host, which is
 * where transitions between phases belong.
 */
function GuidedOnboardingPhaseHost({
  phase,
  syncLevel,
  ...rest
}: Omit<GuidedOnboardingPhaseSource, "onSyncLevelChange"> & {
  phase: WizardPhase;
}) {
  const [selectedSyncLevel, setSelectedSyncLevel] = useState(syncLevel);
  const source: GuidedOnboardingPhaseSource = {
    ...rest,
    onSyncLevelChange: setSelectedSyncLevel,
    syncLevel: selectedSyncLevel,
  };

  return (
    <Dialog open>
      <DialogContent
        // Kept byte-identical to the real shell's card className
        // (`guided-onboarding-dialog.tsx`), `focus:outline-hidden` included:
        // this host hand-copies that string, so the two drift the moment one
        // side changes and a story then frames its phase in chrome the product
        // does not use.
        className="grid-cols-1 gap-0 overflow-hidden p-0 transition-none focus:outline-hidden"
        showCloseButton={false}
        size="large"
      >
        {GUIDED_ONBOARDING_PHASES[phase].render(source)}
      </DialogContent>
    </Dialog>
  );
}

// Every measured value below comes from the fixture module, which is also the
// register of what still needs wiring to real data (ISS-8678). Do not inline a
// count, size, name, or address here — put it there.
const meta: Meta<typeof GuidedOnboardingPhaseHost> = {
  args: {
    account: FIXTURE_ACCOUNT,
    accountCreated: false,
    accountMethod: null,
    allowSkipAccount: true,
    // The catalog shows each phase at a usable state; Session Discovery's
    // Continue is the one control that would otherwise render dead here.
    analysisStarted: true,
    // The create-organization step derives `logoUploadAvailable` from this and
    // `onUploadOrganizationLogo`. With both absent the picker renders "Logo
    // upload is not available yet." and both controls sit dead — the one state
    // a user in this phase never reaches, and the last thing the catalog
    // should show for it. Staging on with no upload handler is the live shape.
    allowStagedOrganizationLogo: true,
    annotations: {},
    brand: <span className="font-semibold">Closedloop.ai</span>,
    desktopAppDownloaded: false,
    desktopMode: true,
    desktopSkipEligibility: OnboardingDesktopSkipEligibility.Eligible,
    discovery: FIXTURE_SESSION_DISCOVERY,
    downloadHrefs: FIXTURE_DOWNLOAD_HREFS,
    githubConnecting: false,
    githubConnection: FIXTURE_GITHUB_DISCONNECTED,
    invitedEmails: [],
    joinableOrganization: FIXTURE_JOINABLE_ORGANIZATION,
    members: FIXTURE_ORGANIZATION_MEMBERS,
    onComplete: fn(),
    onCreateOrganization: fn(),
    organizationChosen: false,
    organizationName: FIXTURE_ORGANIZATION_NAME,
    organizationSlug: FIXTURE_ORGANIZATION_SLUG,
    privacyHref: "/legal/privacy",
    progress: measuredAnalysisProgress(0),
    syncLevel: DataSyncLevel.Full,
    termsHref: "/legal/terms",
  },
  component: GuidedOnboardingPhaseHost,
  parameters: { layout: "fullscreen" },
  // Inherited by every story below, so each one proves its phase mounted and
  // named the blocking dialog it was dropped into — the `DialogTitle` every
  // phase owes. Asserting the exact title text is deliberately NOT done here:
  // `__tests__/guided-onboarding-phase-registry.test.tsx` owns the
  // phase-to-copy pairing, and restating those nine strings would be a second
  // copy to keep in step.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByRole("dialog")).toHaveAccessibleName();
  },
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Guided Onboarding Phases",
};

export default meta;

type Story = StoryObj<typeof GuidedOnboardingPhaseHost>;

export const Welcome: Story = {
  args: { phase: OnboardingPhase.Welcome },
};

export const SessionDiscovery: Story = {
  args: { phase: OnboardingPhase.SessionDiscovery },
};

export const Account: Story = {
  args: { phase: OnboardingPhase.Account },
};

export const CreateOrganization: Story = {
  args: { phase: OnboardingPhase.CreateOrganization },
  // Overrides the meta play, so it restates the dialog assertion. The second
  // one is why this story has a play at all: the step derives
  // `logoUploadAvailable` from two meta args, and when it lands false the
  // picker still RENDERS -- inert, over "Logo upload is not available yet.".
  // The meta play passes either way, so nothing else here can tell the live
  // picker from the dead one. Asserted as an ENABLED control rather than the
  // absence of the refusal copy, because an absence assertion here would pass
  // just as well against a step that stopped rendering the picker entirely.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByRole("dialog")).toHaveAccessibleName();
    await expect(
      await canvas.findByRole("button", { name: "Upload organization logo" })
    ).toBeEnabled();
  },
};

export const ChooseOrganization: Story = {
  args: { phase: OnboardingPhase.ChooseOrganization },
};

export const SyncPolicy: Story = {
  args: { phase: OnboardingPhase.SyncPolicy },
};

export const DownloadDesktop: Story = {
  args: { phase: OnboardingPhase.DownloadDesktop },
};

export const InviteTeam: Story = {
  args: { phase: OnboardingPhase.InviteTeam },
};

export const ConnectGitHub: Story = {
  args: { phase: OnboardingPhase.ConnectGitHub },
};
