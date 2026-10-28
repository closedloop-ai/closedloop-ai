import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import type { Meta, StoryObj } from "@storybook/react";
import { resolveSetupGate } from "../lib/first-user-setup-gate";
import {
  GettingStartedCardShell,
  GettingStartedStepAction,
} from "./getting-started-card-shell";
import { SetupGateStepList, SyncPolicyGateNotice } from "./setup-gate-steps";

/**
 * ISS-12363's PROPOSED wording (pending Kaito/Ottilie review), the same words the
 * web-master prototype passes. The components take copy as a prop because none
 * of it is approved yet.
 */
const PROPOSED_COPY = {
  downloaded: "Desktop downloaded. One more step: choose what syncs.",
  explanation:
    "Sessions on your computer can show up in Desktop before they appear here. The web app only shows what you choose to sync. Choose here or in Desktop; either one finishes setup, and Off counts as a choice.",
  listLabel: "Setup steps",
  stepComplete: "Done",
  stepIncomplete: "Not done yet",
} as const;

/**
 * ISS-12363: the Web setup gate's two steps — download Desktop, then choose a
 * sync policy — in each state the gate can reach. The first user in an
 * organization sees them in the blocking modal; everyone after them sees the
 * same rows in the Getting started card.
 *
 * An explicit Off finishes the sync step; only an unset policy leaves it open.
 */
const meta = {
  title: "Composites/Onboarding/Setup Gate Steps",
  tags: ["experimental"],
  component: SetupGateStepList,
  parameters: { layout: "padded" },
  // The gate itself is a resolved fixture per story (one per state the gate can
  // reach), so the only free control is whether finished steps alone show.
  argTypes: {
    completedOnly: { control: "boolean" },
    copy: { control: false },
    gate: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SetupGateStepList>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Desktop downloaded, no policy chosen: the sync step is next. */
export const Default: Story = {
  args: {
    copy: PROPOSED_COPY,
    gate: resolveSetupGate({
      desktopAppDownloaded: true,
      membership: OrganizationMembership.FirstUser,
      syncPolicy: null,
    }),
  },
};

/** Nothing done yet: the download is next. */
export const NotDownloaded: Story = {
  args: {
    copy: PROPOSED_COPY,
    gate: resolveSetupGate({
      desktopAppDownloaded: false,
      membership: OrganizationMembership.FirstUser,
      syncPolicy: null,
    }),
  },
};

/** Both done, with Off chosen. Off is a finished choice, not an unset one. */
export const OffChosen: Story = {
  args: {
    copy: PROPOSED_COPY,
    gate: resolveSetupGate({
      desktopAppDownloaded: true,
      membership: OrganizationMembership.FirstUser,
      syncPolicy: DataSyncLevel.Off,
    }),
  },
};

/**
 * What the first user sees above the sync-policy picker in the blocking modal:
 * the finished download, the open sync step, and why sessions can be on
 * Desktop but not yet on the web.
 */
export const ModalNotice: Story = {
  args: Default.args,
  render: (args) => (
    <SyncPolicyGateNotice copy={PROPOSED_COPY} gate={args.gate} />
  ),
};

/**
 * A later teammate is never blocked. The bottom-left Getting started card
 * lists what is done and offers the open step as its action, so the open step
 * is named once.
 */
export const InGettingStartedCard: Story = {
  args: {
    copy: PROPOSED_COPY,
    gate: resolveSetupGate({
      desktopAppDownloaded: true,
      membership: OrganizationMembership.ExistingMember,
      syncPolicy: null,
    }),
  },
  render: (args) => (
    <div className="w-60">
      <GettingStartedCardShell
        action={
          <>
            <SetupGateStepList
              completedOnly
              copy={args.copy}
              gate={args.gate}
            />
            <GettingStartedStepAction
              step={PendingOnboardingStep.ChooseSessionSync}
            />
          </>
        }
        completed={3}
        total={5}
      />
    </div>
  ),
};
