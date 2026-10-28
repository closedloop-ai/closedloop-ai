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

// Mirrors apps/api/app/compute-targets/service/compute-target-record.ts's
// buildSecurity: the target is online with a bound gateway on the current
// protocol, but has never bound a managed key yet.
const upgradeAvailableSecurity: TargetSecurity = {
  status: DesktopSecurityStatus.UpgradeAvailable,
  reason: "NO_BOUND_MANAGED_KEY",
  upgradeSupported: true,
};

// LegacyManual with reason TARGET_OFFLINE, not FEATURE_DISABLED — the latter
// reason short-circuits getSecurityLabel to "Standard" regardless of status,
// so it would not exercise this status's own "Reconnect Desktop" label.
const legacyManualSecurity: TargetSecurity = {
  status: DesktopSecurityStatus.LegacyManual,
  reason: "TARGET_OFFLINE",
  upgradeSupported: false,
};

function DesktopSecurityStory() {
  return (
    <div className="flex w-[560px] flex-col gap-4 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <DesktopSecurityBadge security={protectedSecurity} />
        <DesktopSecurityBadge security={updateRequiredSecurity} />
        <DesktopSecurityBadge security={unavailableSecurity} />
        <DesktopSecurityBadge security={upgradeAvailableSecurity} />
        <DesktopSecurityBadge security={legacyManualSecurity} />
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

const meta = {
  title: "Composites v1.0/Compute/Desktop Security",
  component: DesktopSecurityStory,
  // Kitchen-sink comparison across every badge/button state at once, not one
  // concept per story — kept out of the AI manifest for that reason.
  tags: ["deprecated", "autodocs", "!manifest"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof DesktopSecurityStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
