import {
  type ComputeTarget,
  DesktopSecurityStatus,
} from "@repo/api/src/types/compute-target";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { ShieldAlert, Trash2 } from "lucide-react";
import { fn } from "storybook/test";
import { ComputeTargetCard } from "./compute-target-card";
import {
  DesktopSecurityBadge,
  DesktopUpdateDownloadButton,
} from "./desktop-security";

const protectedTarget: ComputeTarget["security"] = {
  status: DesktopSecurityStatus.Protected,
  reason: "BOUND_DESKTOP_MANAGED_KEY",
  upgradeSupported: false,
};

const upgradeTarget: ComputeTarget["security"] = {
  status: DesktopSecurityStatus.UpdateRequired,
  reason: "UNSUPPORTED_DESKTOP_VERSION",
  upgradeSupported: true,
};

const meta = {
  title: "Composites v1.0/Compute/Compute Target Card",
  component: ComputeTargetCard,
  tags: ["deprecated", "autodocs"],
  args: {
    name: "Marisol’s MacBook Pro",
    isOnline: true,
    subtitle: "macOS - Last seen May 29, 2026, 10:04 AM",
    securityBadge: <DesktopSecurityBadge security={protectedTarget} />,
    actions: (
      <>
        <Button onClick={fn()} size="sm" variant="outline">
          <ShieldAlert className="h-4 w-4" />
          Upgrade security
        </Button>
        <DesktopUpdateDownloadButton
          downloadUrl="https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg"
          isLoading={false}
        />
        <Button onClick={fn()} size="sm" variant="outline">
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </>
    ),
  },
} satisfies Meta<typeof ComputeTargetCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ProtectedOnline: Story = {};

export const UpgradeAvailableOffline: Story = {
  args: {
    isOnline: false,
    securityBadge: <DesktopSecurityBadge security={upgradeTarget} />,
    actions: (
      <DesktopUpdateDownloadButton downloadUrl={null} isLoading={true} />
    ),
  },
};
