import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY } from "@repo/api/src/types/onboarding-source-ratio-unavailable-flag";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  FIXTURE_ACCOUNT,
  FIXTURE_ANALYSIS_PROGRESS,
  FIXTURE_DOWNLOAD_HREFS,
  FIXTURE_FIRST_MEMBER,
  FIXTURE_GITHUB_CONNECTED,
  FIXTURE_GITHUB_DISCONNECTED,
  FIXTURE_GITHUB_RECONNECT,
  FIXTURE_JOINABLE_ORGANIZATION,
  FIXTURE_ORGANIZATION_MEMBERS,
  FIXTURE_ORGANIZATION_NAME,
  FIXTURE_ORGANIZATION_SLUG,
  FIXTURE_SESSION_DISCOVERY,
  FIXTURE_WITHHELD_RATIO_DISCOVERY,
  measuredAnalysisProgress,
} from "../lib/guided-onboarding-fixtures";
import {
  OnboardingDesktopSkipEligibility,
  UNKNOWN_ACCOUNT,
  UNKNOWN_ANALYSIS_PROGRESS,
  UNKNOWN_GITHUB_CONNECTION,
  UNKNOWN_JOINABLE_ORGANIZATION,
  UNKNOWN_ORGANIZATION_MEMBERS,
  UNKNOWN_SESSION_DISCOVERY,
} from "./guided-onboarding-data";
import { GuidedOnboardingDialog } from "./guided-onboarding-dialog";
import type {
  GuidedOnboardingDialogProps,
  WizardPhase,
} from "./guided-onboarding-types";
import {
  DESKTOP_WELCOME_CTA_LABEL,
  WEB_WELCOME_CTA_LABEL,
} from "./guided-onboarding-welcome-copy";

/**
 * Every story drives the real wizard through a stateful host, so a primary CTA
 * advances the phase and Back returns to it. A no-op `onComplete` made the
 * welcome CTA visibly do nothing, which is not an example of anything.
 *
 * `onStart` lands on `SessionDiscovery` because that is what
 * `resolvePostWelcomePhase` returns for a Desktop run, and `desktopMode`
 * defaults to true for every story here. It used to go to `Account` — the Web
 * branch — so `DesktopWelcome` walked a path production never takes and would
 * have stayed green through a change to the real wiring (ISS-10890 moved the
 * sync choice back behind the organization step).
 */
function GuidedOnboardingDialogHost({
  githubSkippable = false,
  initialPhase = OnboardingPhase.Welcome,
  logoUploadDisabled = false,
  logoUploadFails = false,
  newOrganizationLogo,
  open,
  ...props
}: Omit<
  GuidedOnboardingDialogProps,
  | "newOrganizationLogo"
  | "onComplete"
  | "onSkipGitHub"
  | "onUploadOrganizationLogo"
  | "phase"
> & {
  /**
   * Whether this host offers the deferral. Off by default because the canonical
   * screen has no Skip — the control exists for a host that opts in (ISS-8352).
   */
  githubSkippable?: boolean;
  initialPhase?: WizardPhase;
  logoUploadDisabled?: boolean;
  logoUploadFails?: boolean;
  newOrganizationLogo?: GuidedOnboardingDialogProps["newOrganizationLogo"];
}) {
  const [phase, setPhase] = useState<WizardPhase>(initialPhase);
  const [history, setHistory] = useState<readonly WizardPhase[]>([]);
  const [finished, setFinished] = useState(false);
  const [confirmedLogo, setConfirmedLogo] =
    useState<GuidedOnboardingDialogProps["newOrganizationLogo"]>(
      newOrganizationLogo
    );

  const goTo = (next: WizardPhase) => {
    setHistory((current) => [...current, phase]);
    setPhase(next);
  };

  // The flow ends at `dashboard_available`, which the wizard renders no screen
  // for — it is the phase the modal CLOSES on. Finishing therefore dismisses the
  // dialog, which is what a host does, instead of parking it on some other
  // phase's screen (ISS-8345).
  const finish = () => setFinished(true);

  return (
    <GuidedOnboardingDialog
      {...props}
      newOrganizationLogo={confirmedLogo}
      onBack={() => {
        const previous = history.at(-1);
        if (!previous) {
          return;
        }
        setHistory((current) => current.slice(0, -1));
        setPhase(previous);
      }}
      onComplete={finish}
      onContinue={() => goTo(OnboardingPhase.Account)}
      onContinueFromDownload={() => goTo(OnboardingPhase.InviteTeam)}
      onContinueFromGitHub={finish}
      onContinueFromInvites={() => goTo(OnboardingPhase.ConnectGitHub)}
      onContinueFromOrganization={() => goTo(OnboardingPhase.SyncPolicy)}
      onContinueFromSync={() => goTo(OnboardingPhase.DownloadDesktop)}
      onCreateOrganization={() => goTo(OnboardingPhase.SyncPolicy)}
      onSkipGitHub={githubSkippable ? finish : undefined}
      onStart={() => goTo(OnboardingPhase.SessionDiscovery)}
      onStartCreateOrganization={() => goTo(OnboardingPhase.CreateOrganization)}
      onUploadOrganizationLogo={
        logoUploadDisabled
          ? undefined
          : async () => {
              await Promise.resolve();
              if (logoUploadFails) {
                throw new Error("Provider refused logo");
              }
              setConfirmedLogo(
                <span
                  aria-label="AcmeCo logo"
                  className="flex size-14 items-center justify-center rounded-lg bg-primary/10 font-semibold text-primary"
                  role="img"
                >
                  A
                </span>
              );
            }
      }
      open={open && !finished}
      phase={phase}
    />
  );
}

// Built from the labels themselves, not re-typed: this `play` is the only
// storybook assertion on the welcome CTA, and a renamed label that left the
// words here behind would fail the sweep rather than the suite that owns the
// rename. Anchored so one label cannot satisfy a locator meant for another.
// Neither label carries a regex metacharacter, so no escaping is needed.
const WELCOME_CTA = new RegExp(
  `^(${DESKTOP_WELCOME_CTA_LABEL}|${WEB_WELCOME_CTA_LABEL})$`,
  "i"
);
const SKIP_CTA = /skip for now/i;
const DOWNLOAD_CTA = /Download .* Desktop App/;
const DOWNLOAD_UNAVAILABLE_LINE = "Skipping this step isn't available yet.";
/** The eyebrow of the step a Desktop start lands on (ISS-10890 order). */
const SESSION_DISCOVERY_EYEBROW = "Session discovery";
const CREATE_ORG_CTA = /create new organization/i;
const BACK_CTA = /back/i;
const CHOOSE_ORG_HEADING = /choose an organization/i;

// Every measured value below comes from the fixture module, which is also the
// register of what still needs wiring to real data (ISS-8678). Do not inline a
// count, size, name, or address here — put it there.
const meta: Meta<typeof GuidedOnboardingDialogHost> = {
  args: {
    account: FIXTURE_ACCOUNT,
    brand: <span className="font-semibold">Closedloop.ai</span>,
    discovery: FIXTURE_SESSION_DISCOVERY,
    downloadHrefs: FIXTURE_DOWNLOAD_HREFS,
    githubConnection: FIXTURE_GITHUB_DISCONNECTED,
    joinableOrganization: FIXTURE_JOINABLE_ORGANIZATION,
    members: FIXTURE_ORGANIZATION_MEMBERS,
    open: true,
    organizationName: FIXTURE_ORGANIZATION_NAME,
    organizationSlug: FIXTURE_ORGANIZATION_SLUG,
  },
  component: GuidedOnboardingDialogHost,
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <GuidedOnboardingDialogHost key={remountKey(args.initialPhase)} {...args} />
  ),
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Guided Onboarding Dialog",
};

export default meta;

type Story = StoryObj<typeof GuidedOnboardingDialogHost>;

export const DesktopWelcome: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: WELCOME_CTA,
      })
    );
    // The Desktop start goes to session discovery, so that is what this
    // asserts. The Welcome CTA going away is asserted on the SAME locator the
    // click above just resolved, so the absence cannot be a locator that never
    // matched anything.
    await expect(
      await canvas.findByText(SESSION_DISCOVERY_EYEBROW)
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: WELCOME_CTA })).toBe(
      null
    );
  },
};

export const RestoringSavedProgress: Story = {
  args: {
    restoring: true,
  },
};

export const CompactAccount: Story = {
  args: {
    initialPhase: OnboardingPhase.Account,
  },
  globals: {
    viewport: { value: "mobile1" },
  },
};

export const FirstOrganization: Story = {
  args: {
    initialPhase: OnboardingPhase.CreateOrganization,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.upload(
      await canvas.findByLabelText("Organization logo file"),
      new File(["logo"], "logo.png", { type: "image/png" })
    );
    await expect(await canvas.findByLabelText("AcmeCo logo")).toBeVisible();
  },
};

export const OrganizationLogoUploadFailure: Story = {
  args: {
    initialPhase: OnboardingPhase.CreateOrganization,
    logoUploadFails: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.upload(
      await canvas.findByLabelText("Organization logo file"),
      new File(["logo"], "logo.png", { type: "image/png" })
    );
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Logo upload failed. Try again."
    );
  },
};

export const ChooseOrganizationToCreateNew: Story = {
  args: {
    initialPhase: OnboardingPhase.ChooseOrganization,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole("button", { name: CREATE_ORG_CTA })
    );
    await expect(
      await canvas.findByRole("button", { name: BACK_CTA })
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: BACK_CTA }));
    await expect(
      await canvas.findByRole("heading", { name: CHOOSE_ORG_HEADING })
    ).toBeVisible();
  },
};

export const SyncChoice: Story = {
  args: {
    initialPhase: OnboardingPhase.SyncPolicy,
    syncLevel: DataSyncLevel.Full,
  },
};

export const InviteTeam: Story = {
  args: {
    initialPhase: OnboardingPhase.InviteTeam,
    members: FIXTURE_ORGANIZATION_MEMBERS,
  },
};

export const RequiredGitHubConnection: Story = {
  args: {
    initialPhase: OnboardingPhase.ConnectGitHub,
  },
};

/** A grant that lapsed. Worded as a repair, never as first-time setup. */
export const GitHubConnectionNeedsRepair: Story = {
  args: {
    githubConnection: FIXTURE_GITHUB_RECONNECT,
    initialPhase: OnboardingPhase.ConnectGitHub,
  },
};

/**
 * The state a GitHub sign-in lands in, and the one the step reaches once the
 * connect handoff returns: confirmed, not asked again.
 */
export const GitHubAlreadyConnected: Story = {
  args: {
    githubConnection: FIXTURE_GITHUB_CONNECTED,
    initialPhase: OnboardingPhase.ConnectGitHub,
  },
};

/** The connect handoff in flight. Both actions are locked while it runs. */
export const GitHubConnectionInFlight: Story = {
  args: {
    githubConnecting: true,
    initialPhase: OnboardingPhase.ConnectGitHub,
  },
};

/**
 * A host that opts into deferral. The canonical screen has none — see
 * `guided-onboarding-github-step.tsx` for why this is a host choice.
 */
export const GitHubConnectionWithHostSkip: Story = {
  args: {
    githubSkippable: true,
    initialPhase: OnboardingPhase.ConnectGitHub,
  },
};

/**
 * The honest states, which is what a host renders before its data resolves.
 * Nothing here may show a count, a size, a duration, a company, or a person —
 * the wizard shipped inventing all five (ISS-8678).
 */
export const AnalysisBeforeScanReports: Story = {
  args: {
    discovery: UNKNOWN_SESSION_DISCOVERY,
    initialPhase: OnboardingPhase.SessionDiscovery,
    progress: measuredAnalysisProgress(40),
  },
};

/**
 * A scan that reported everything: counts, a size and an estimate. The one state
 * that CANNOT demonstrate omission, which is why the two stories below exist.
 */
export const AnalysisWithMeasuredScan: Story = {
  args: {
    discovery: FIXTURE_SESSION_DISCOVERY,
    initialPhase: OnboardingPhase.SessionDiscovery,
    progress: FIXTURE_ANALYSIS_PROGRESS,
  },
};

/**
 * A measured scan whose PROGRESS nobody has reported. The bar sweeps and the
 * caption is empty; it does not sit at 0% claiming a measurement of no work
 * done.
 */
export const AnalysisWithUnknownProgress: Story = {
  args: {
    discovery: FIXTURE_SESSION_DISCOVERY,
    initialPhase: OnboardingPhase.SessionDiscovery,
    progress: UNKNOWN_ANALYSIS_PROGRESS,
  },
};

/**
 * ISS-10961, behind its closed-by-default key. Claude Code's store has outlived
 * its transcripts (68 found, 72 analyzed), so no percentage exists for that row
 * — and the row now SAYS so, instead of leaving a held hatch that reads as a
 * scan still running. Codex and Cursor are untouched beside it, which is the
 * point: the three states have to be tellable apart at a glance.
 *
 * Geometry is what this story pins and the suite cannot: that the three bars
 * share a right edge, so the row whose message is "there is no measurement
 * here" does not also get the shortest track.
 */
export const AnalysisWithUnavailableRatio: Story = {
  args: {
    discovery: FIXTURE_WITHHELD_RATIO_DISCOVERY,
    initialPhase: OnboardingPhase.SessionDiscovery,
    progress: measuredAnalysisProgress(99),
  },
  // The preview mounts `AppCoreStoryProviders` globally and owns the single
  // harness, so a story opts its flags in through this parameter rather than
  // wrapping itself in a second copy of the providers.
  parameters: {
    appCore: { enabledFlags: [ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY] },
  },
};

/**
 * The same three rows at 320-wide. The status text carries a third clause here,
 * which at this width is exactly what used to paint through the source label and
 * clip its glyph — so the status takes a line of its own below `sm`, the way the
 * bar already does.
 */
export const AnalysisWithUnavailableRatioNarrow: Story = {
  ...AnalysisWithUnavailableRatio,
  globals: {
    viewport: { value: "mobile1" },
  },
};

/** The sync step mid-write: Continue is busy and cannot be pressed twice. */
export const SyncPolicySaving: Story = {
  args: {
    initialPhase: OnboardingPhase.SyncPolicy,
    syncSaving: true,
  },
};

/**
 * A write that failed. The step stays on screen with the choice intact so it
 * can be retried — dismissing it would report a choice that never reached disk.
 */
export const SyncPolicySaveFailed: Story = {
  args: {
    initialPhase: OnboardingPhase.SyncPolicy,
    syncError: "We couldn't save your choice. Please try again.",
  },
};

export const InviteWithUnknownMembership: Story = {
  args: {
    initialPhase: OnboardingPhase.InviteTeam,
    members: UNKNOWN_ORGANIZATION_MEMBERS,
  },
};

export const GitHubConnectionBeforeStatusReports: Story = {
  args: {
    githubConnection: UNKNOWN_GITHUB_CONNECTION,
    initialPhase: OnboardingPhase.ConnectGitHub,
  },
};

export const ChooseOrganizationBeforeLookupReports: Story = {
  args: {
    account: UNKNOWN_ACCOUNT,
    initialPhase: OnboardingPhase.ChooseOrganization,
    joinableOrganization: UNKNOWN_JOINABLE_ORGANIZATION,
  },
};

export const ChooseOrganizationWithNoAuthorizedOrganization: Story = {
  args: {
    initialPhase: OnboardingPhase.ChooseOrganization,
    joinableOrganization: { status: "none" },
  },
};

/**
 * The lookup REPORTED a failure (ISS-11158). Neither the empty state's claim nor
 * the skeleton's announcement of an ongoing check is true here, so the row states
 * what happened and offers the re-read.
 */
export const ChooseOrganizationWhenTheLookupFailed: Story = {
  args: {
    initialPhase: OnboardingPhase.ChooseOrganization,
    joinableOrganization: { status: "unavailable" },
    onRetryJoinableOrganizationLookup: () => undefined,
  },
};

/** A signer whose company could not be inferred gets "your company", not a name. */
export const FirstOrganizationWithoutInferredCompany: Story = {
  args: {
    initialPhase: OnboardingPhase.CreateOrganization,
    organizationName: "",
    organizationSlug: "",
  },
};

export const InviteAsFirstMember: Story = {
  args: {
    initialPhase: OnboardingPhase.InviteTeam,
    members: FIXTURE_FIRST_MEMBER,
  },
};

/**
 * A send that is still in flight. Nothing is announced yet — the composer
 * reports the pending send itself (ISS-8348).
 */
export const InviteSendPending: Story = {
  args: {
    initialPhase: OnboardingPhase.InviteTeam,
    inviteOutcome: { status: "pending" },
    members: FIXTURE_ORGANIZATION_MEMBERS,
  },
};

/**
 * Five addresses submitted, two actually invited, three already in the org. The
 * confirmation states the server's count, never the number typed — reporting
 * the submitted list here is what made this read "5 emails sent".
 */
export const InviteSendPartial: Story = {
  args: {
    initialPhase: OnboardingPhase.InviteTeam,
    inviteOutcome: {
      alreadyMember: 3,
      failed: 0,
      invited: 2,
      status: "partial",
    },
    members: FIXTURE_ORGANIZATION_MEMBERS,
  },
};

/** Everyone listed was already a member, so no invitation went out at all. */
export const InviteSendAlreadyMembers: Story = {
  args: {
    initialPhase: OnboardingPhase.InviteTeam,
    inviteOutcome: { alreadyMember: 3, status: "already-member" },
    members: FIXTURE_ORGANIZATION_MEMBERS,
  },
};

/** A rejected send keeps the composer mounted so the batch can be retried. */
export const InviteSendFailed: Story = {
  args: {
    initialPhase: OnboardingPhase.InviteTeam,
    inviteOutcome: {
      failed: 2,
      message: "We couldn't reach the invitation service. Try again.",
      status: "failed",
    },
    members: FIXTURE_ORGANIZATION_MEMBERS,
  },
};

export const DesktopDownloadSkippable: Story = {
  args: {
    desktopSkipEligibility: OnboardingDesktopSkipEligibility.Eligible,
    initialPhase: OnboardingPhase.DownloadDesktop,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(
      await canvas.findByRole("button", { name: SKIP_CTA })
    ).toBeVisible();
  },
};

export const DesktopDownloadRequired: Story = {
  args: {
    desktopSkipEligibility: OnboardingDesktopSkipEligibility.Required,
    initialPhase: OnboardingPhase.DownloadDesktop,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    // The install action is the route forward; the deferral is withheld and,
    // because the organization WAS measured, withheld without comment.
    await expect(
      await canvas.findByRole("link", { name: DOWNLOAD_CTA })
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: SKIP_CTA })).toBeNull();
    await expect(canvas.queryByText(DOWNLOAD_UNAVAILABLE_LINE)).toBeNull();
  },
};

export const DesktopDownloadBeforeEligibilityReports: Story = {
  args: {
    desktopSkipEligibility: OnboardingDesktopSkipEligibility.Unknown,
    initialPhase: OnboardingPhase.DownloadDesktop,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    // Unmeasured: the deferral is withheld like the required arm, but the
    // screen says so rather than passing for a measured refusal.
    await expect(
      await canvas.findByText(DOWNLOAD_UNAVAILABLE_LINE)
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: SKIP_CTA })).toBeNull();
  },
};
