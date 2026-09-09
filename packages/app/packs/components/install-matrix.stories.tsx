import { PackInstallState } from "@repo/app/packs/lib/install-state";
import type { PackComponentInstallMatrix } from "@repo/app/packs/lib/pack-install-matrix";
import type { Meta, StoryObj } from "@storybook/react";
import { InstallMatrix } from "./install-matrix";

// A representative org-wide matrix: an all-installed box, an offline box (state
// unknown), a box with a failed install, and a box mid-conversion — so the
// story lands on a matrix with problems, not an all-green mock (the FEA-4074
// prototype's default). Rows = compute targets, columns = harnesses.
const MATRIX: PackComponentInstallMatrix = {
  componentId: "cmp-pre-commit-guard",
  componentName: "pre-commit-guard",
  cells: [
    {
      computeTargetId: "tgt-a",
      computeTargetName: "parkers-mbp",
      harness: "claude",
      state: PackInstallState.Installed,
      installedVersion: "2.4.0",
      failureReason: null,
    },
    {
      computeTargetId: "tgt-a",
      computeTargetName: "parkers-mbp",
      harness: "codex",
      state: PackInstallState.Updatable,
      installedVersion: "2.3.0",
      failureReason: null,
    },
    {
      computeTargetId: "tgt-b",
      computeTargetName: "mbp-ci-runner",
      harness: "claude",
      state: PackInstallState.Offline,
      installedVersion: null,
      failureReason: null,
    },
    {
      computeTargetId: "tgt-b",
      computeTargetName: "mbp-ci-runner",
      harness: "codex",
      state: PackInstallState.Offline,
      installedVersion: null,
      failureReason: null,
    },
    {
      computeTargetId: "tgt-c",
      computeTargetName: "linux-build-02",
      harness: "claude",
      state: PackInstallState.Failed,
      installedVersion: null,
      failureReason: "npm install exited 1",
    },
    {
      computeTargetId: "tgt-c",
      computeTargetName: "linux-build-02",
      harness: "codex",
      state: PackInstallState.Converting,
      installedVersion: null,
      failureReason: null,
    },
    {
      computeTargetId: "tgt-d",
      computeTargetName: "win-desktop-01",
      harness: "claude",
      state: PackInstallState.NotInstalled,
      installedVersion: null,
      failureReason: null,
    },
    {
      computeTargetId: "tgt-d",
      computeTargetName: "win-desktop-01",
      harness: "codex",
      state: PackInstallState.Installed,
      installedVersion: "2.4.0",
      failureReason: null,
    },
  ],
};

const meta = {
  title: "App Core/Packs/Install Matrix",
  component: InstallMatrix,
  tags: ["autodocs"],
  args: {
    matrix: MATRIX,
    componentName: "pre-commit-guard",
  },
  argTypes: {
    componentName: { control: "text" },
    matrix: { control: "object" },
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof InstallMatrix>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The org-wide install matrix for one component: the reconciled rollup card,
 * the machine/harness/status filter, and the per-(target × harness) grid.
 * Offline and failed rows stay visible and filterable.
 */
export const Default: Story = {};

/**
 * No targets: the honest empty state, not a fabricated all-green grid.
 */
export const Empty: Story = {
  args: { matrix: null },
};
