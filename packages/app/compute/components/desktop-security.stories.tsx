import { DesktopSecurityStatus } from "@closedloop-ai/loops-api/compute-target";
import type { Meta, StoryObj } from "@storybook/react";
import {
  DesktopSecurityBadge,
  DesktopUpdateDownloadButton,
  type TargetSecurity,
} from "./desktop-security";

const protectedSecurity: TargetSecurity = {
  status: DesktopSecurityStatus.Protected,
  reason: "BOUND_DESKTOP_MANAGED_KEY",
  upgradeSupported: true,
};

const updateRequiredSecurity: TargetSecurity = {
  status: DesktopSecurityStatus.UpdateRequired,
  reason: "UNSUPPORTED_DESKTOP_VERSION",
  upgradeSupported: true,
};

const unavailableSecurity: TargetSecurity = {
  status: DesktopSecurityStatus.Unknown,
  reason: "LOOKUP_FAILED",
  upgradeSupported: false,
};

function DesktopSecurityStory() {
  return (
    <div className="flex w-[560px] flex-col gap-4 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <DesktopSecurityBadge security={protectedSecurity} />
        <DesktopSecurityBadge security={updateRequiredSecurity} />
        <DesktopSecurityBadge security={unavailableSecurity} />
      </div>
      <div className="flex flex-wrap gap-2">
        <DesktopUpdateDownloadButton
          downloadUrl="https://closedloop.ai/download"
          isLoading={false}
        />
        <DesktopUpdateDownloadButton downloadUrl={null} isLoading />
        <DesktopUpdateDownloadButton downloadUrl={null} isLoading={false} />
      </div>
    </div>
  );
}

/**
 * A small badge showing a compute target's security state, such as
 * protected, update required, or unavailable, shown next to a button for
 * downloading the desktop update that fixes it. Use the two together
 * wherever a target's security status appears, so a reader sees both the
 * problem and the one-click fix in the same place. The download button
 * disables itself and shows a spinner, or reads Download unavailable,
 * whenever there is no download link yet, rather than linking nowhere.
 */
const meta = {
  title: "Composites/Compute/Desktop Security",
  component: DesktopSecurityStory,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof DesktopSecurityStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
