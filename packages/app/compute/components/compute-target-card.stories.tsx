import {
  type CheckResult,
  type ComputeTarget,
  DesktopSecurityStatus,
} from "@repo/api/src/types/compute-target";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { ShieldAlert, Trash2 } from "lucide-react";
import { fn } from "storybook/test";
import { ComputeTargetCard } from "./compute-target-card";
import { ComputeTargetSystemCheck } from "./compute-target-system-check";
import {
  DesktopSecurityBadge,
  DesktopUpdateDownloadButton,
} from "./desktop-security";
import { SystemCheckResults } from "./system-check-results";

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

const checks: CheckResult[] = [
  {
    id: "git",
    label: "Git",
    passed: true,
    required: true,
    version: "2.49.0",
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    passed: false,
    required: true,
    error: "Not found",
    remediation: "Install Claude Code and retry.",
  },
];

const meta = {
  title: "App Core/Compute/Compute Target Card",
  component: ComputeTargetCard,
  args: {
    name: "Mike’s MacBook Pro",
    isOnline: true,
    subtitle: "macOS - Last seen May 29, 2026, 10:04 AM",
    shareChecked: true,
    onShareCheckedChange: fn(),
    securityBadge: <DesktopSecurityBadge security={protectedTarget} />,
    actions: (
      <>
        <Button onClick={fn()} size="sm" variant="outline">
          <ShieldAlert className="h-4 w-4" />
          Upgrade security
        </Button>
        <DesktopUpdateDownloadButton
          downloadUrl="https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg"
          isLoading={false}
        />
        <Button onClick={fn()} size="sm" variant="outline">
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </>
    ),
    systemCheck: (
      <ComputeTargetSystemCheck
        checkedAtLabel="May 30, 2026, 9:41 AM"
        content={<SystemCheckResults checks={checks} />}
        failureCount={1}
        hasResult
        isEligible
        onAction={fn()}
        targetName="Mike’s MacBook Pro"
      />
    ),
  },
} satisfies Meta<typeof ComputeTargetCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ProtectedOnline: Story = {};

export const UpgradeAvailableOffline: Story = {
  args: {
    isOnline: false,
    shareChecked: false,
    shareDisabled: true,
    securityBadge: <DesktopSecurityBadge security={upgradeTarget} />,
    actions: (
      <DesktopUpdateDownloadButton downloadUrl={null} isLoading={true} />
    ),
    systemCheck: (
      <ComputeTargetSystemCheck
        actionDisabled
        hasResult={false}
        isEligible={false}
        onAction={fn()}
        targetName="Mike’s MacBook Pro"
      />
    ),
  },
};
