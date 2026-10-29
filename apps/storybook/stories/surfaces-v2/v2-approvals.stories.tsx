import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ApprovalsPanel } from "../../../desktop/src/renderer/components/approvals/ApprovalsPanel";
import { pageTitleForNav } from "../../../desktop/src/renderer/navigation/nav-config";
import { NavId } from "../../../desktop/src/renderer/navigation/route-table";
import {
  alwaysAllowRulesFixture,
  pendingApprovalsFixture,
} from "./test/desktop-only-fixtures";
import { DesktopPage, expectActiveDesktopNavItem } from "./test/desktop-page";

// ISS-11361 Target sidebar: Approvals (Desktop only).
// The desktop app's Approvals page (`approvals/ApprovalsPanel`, rendered by
// `App.tsx` for `#/approvals`) in the desktop shell's own frame: gateway
// requests held for a decision (`desktopApi.getPendingApprovals`) and the
// granted always-allow rules (`desktopApi.getSettings().alwaysAllowRules`).

type ApprovalsData = {
  approvals: unknown[] | (() => Promise<unknown[]>);
  rules: unknown[];
};

const POPULATED: ApprovalsData = {
  approvals: pendingApprovalsFixture,
  rules: alwaysAllowRulesFixture,
};

function approvalsBridge({ approvals, rules }: ApprovalsData) {
  const resolved = async () => undefined;
  return {
    getPendingApprovals:
      typeof approvals === "function"
        ? approvals
        : () => Promise.resolve(approvals),
    getSettings: () => Promise.resolve({ alwaysAllowRules: rules }),
    approveApproval: resolved,
    denyApproval: resolved,
    alwaysAllowApproval: resolved,
    clearPendingApprovals: resolved,
    removeAlwaysAllowRule: resolved,
  };
}

const meta = {
  title: "Surfaces/Desktop Only/Approvals",
  tags: ["stable"],
  render: (_args, { parameters }) => (
    <DesktopPage
      bridge={approvalsBridge(
        (parameters.approvals as ApprovalsData | undefined) ?? POPULATED
      )}
      navId={NavId.Approvals}
    >
      <ApprovalsPanel />
    </DesktopPage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: pageTitleForNav(NavId.Approvals),
      })
    ).toBeVisible();
    await expectActiveDesktopNavItem(
      canvasElement,
      pageTitleForNav(NavId.Approvals)
    );
  },
};

/** The first read of the queue is still in flight. */
export const Loading: Story = {
  parameters: {
    approvals: {
      approvals: () =>
        new Promise<never>(() => {
          // Never settles.
        }),
      rules: [],
    },
  },
};

/** Nothing is waiting and no always-allow rule is granted. */
export const Empty: Story = {
  parameters: { approvals: { approvals: [], rules: [] } },
};
