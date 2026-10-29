import type { Meta, StoryObj } from "@storybook/react";
import { buildComputeTargetFixture } from "../../settings/v2/test-fixtures/device-panel-fixtures";
import { ComputeTargetRow } from "./compute-target-row";

/**
 * The registered-Desktop row both Settings trees compose (PLN-1915 D9).
 *
 * The pair below is the point: OWNERSHIP decides which controls exist. A target
 * carrying `ownerName` is somebody else's machine, and `/compute-targets/{id}`
 * DELETE is `deleteOwned` — so the row offers nothing rather than offering
 * controls the server would refuse.
 */
const meta: Meta<typeof ComputeTargetRow> = {
  args: {
    desktopUpdateUrl: null,
    isDesktopReleaseLoading: false,
    target: buildComputeTargetFixture(),
    updateAction: null,
  },
  component: ComputeTargetRow,
  parameters: { layout: "padded" },
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Compute/Compute Target Row",
};

export default meta;

type Story = StoryObj<typeof ComputeTargetRow>;

/** The viewer's own machine: removal and the action slots are offered. */
export const Owned: Story = {};

/** Offline, so the row states it rather than implying the machine is reachable. */
export const OwnedOffline: Story = {
  args: { target: buildComputeTargetFixture({ isOnline: false }) },
};

/**
 * Somebody else's machine, as an API older than ISS-12617 could still list it.
 * No Delete, no action slots — not disabled ones, absent ones. ISS-12450
 * removes this case once no such API can serve.
 */
export const SharedByAnotherOwner: Story = {
  args: {
    target: buildComputeTargetFixture({
      machineName: "Grace-MBP",
      ownerName: "Grace Hopper",
    }),
  },
};
