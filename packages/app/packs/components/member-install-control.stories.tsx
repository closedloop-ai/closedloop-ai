import { PackInstallState } from "@repo/app/packs/lib/install-state";
import { MemberInstallDispatchTone } from "@repo/app/packs/lib/member-install-dispatch-copy";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { MemberInstallControl } from "./member-install-control";

/**
 * The member's ACT affordance for one (machine × harness) cell (ISS-5125). The
 * matrix below is the whole contract: which install states earn a button, which
 * earn a spoken reason instead, and how a dispatch outcome reads next to a state
 * it deliberately does not overwrite.
 */
const meta = {
  title: "Composites/Packs/Member Install Control",
  component: MemberInstallControl,
  tags: ["autodocs"],
  args: {
    state: PackInstallState.NotInstalled,
    packName: "release-captain",
    computeTargetName: "parkers-mbp",
    harnessLabel: "Claude",
    dispatch: null,
    isPending: false,
    onAction: fn(),
  },
  argTypes: {
    computeTargetName: { control: "text" },
    // The last dispatch outcome for this cell: message, tone, and whether
    // offering the action again is safe.
    dispatch: { control: "object" },
    harnessLabel: { control: "text" },
    isPending: { control: "boolean" },
    onAction: { control: false, table: { category: "Events" } },
    packName: { control: "text" },
    state: { control: "select", options: Object.values(PackInstallState) },
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof MemberInstallControl>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The forward step: the pack is absent on this cell. */
export const NotInstalled: Story = {};

/** A previous install failed — the same call, named honestly as a retry. */
export const FailedOffersRetry: Story = {
  args: { state: PackInstallState.Failed },
};

/** In flight: the button is disabled and says what it is doing. */
export const Pending: Story = {
  args: { isPending: true },
};

/**
 * Settled states own no control and need no excuse — the row's status line
 * already reads truthfully. Update and uninstall have no member-scoped route,
 * so offering either here would be a button with nothing behind it.
 */
export const InstalledHasNoControl: Story = {
  args: { state: PackInstallState.Installed },
};

export const UpdatableHasNoControl: Story = {
  args: { state: PackInstallState.Updatable },
};

/** Blocked, and said out loud — a missing button with no reason reads as a bug. */
export const OfflineExplainsItself: Story = {
  args: { state: PackInstallState.Offline },
};

export const UnsupportedExplainsItself: Story = {
  args: { state: PackInstallState.Unsupported },
};

export const AlreadyRunning: Story = {
  args: { state: PackInstallState.Converting },
};

/** The node took it. The cell's own state is untouched until it reports back. */
export const DispatchStarted: Story = {
  args: {
    dispatch: {
      message: "Install started on parkers-mbp.",
      tone: MemberInstallDispatchTone.Success,
      retryable: false,
    },
  },
};

/**
 * The ambiguous outcome: the install may already be running, so the button is
 * withdrawn even though the cell still reads "not installed" — retrying here is
 * how a member runs the same install twice.
 */
export const DispatchUnconfirmed: Story = {
  args: {
    dispatch: {
      message:
        "Install sent to parkers-mbp. We couldn't confirm it started — this machine will report back when it does.",
      tone: MemberInstallDispatchTone.Pending,
      retryable: false,
    },
  },
};

/** Provably not installed, so the control stays offered. */
export const DispatchFailedStaysRetryable: Story = {
  args: {
    dispatch: {
      message:
        "parkers-mbp is offline, so nothing was installed. Try again once it reconnects.",
      tone: MemberInstallDispatchTone.Danger,
      retryable: true,
    },
  },
};
