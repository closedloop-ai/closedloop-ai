import type { Meta, StoryObj } from "@storybook/react";
import { PackInstallState } from "../lib/install-state";
import { MemberInstallDispatchTone } from "../lib/member-install-dispatch-copy";
import type { PackComponentInstallMatrix } from "../lib/pack-install-matrix";
import type { PackView } from "../lib/pack-view";
import { mockPackViews } from "../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../lib/packs-context";
import { memberInstallCellKey } from "./member-targets-block";
import { PackDetail } from "./pack-detail";

/**
 * This is the full detail page for one pack: a bundle of ready-made agents,
 * skills, commands, and other add-ons that installs into a coding harness
 * like Claude Code or Codex. It shows a header with star rating, publisher,
 * and supported-harness badges, a row of metric cards, and tabs for
 * Contents, Team usage, Performance, Distribution, and an install matrix.
 * Reach for it when you need everything about a single pack, including
 * installing or removing it per harness, rather than Packs Workspace, which
 * is for browsing many packs at once. Controls like the install buttons or
 * withdrawing a distribution only appear when the page around it supplies
 * the matching handler, so what you can do here depends on where it is
 * mounted.
 */
const meta = {
  title: "Surfaces/Pack Detail",
  component: PackDetail,
  tags: ["autodocs"],
  args: {
    pack: mockPackViews[0],
    context: createPacksContext(PacksMode.DesktopTeam),
  },
  // The callbacks below are deliberately absent from `args`. On this component a
  // handler's PRESENCE is the feature switch — `onWithdrawDistribution` is what
  // puts the withdraw control on the Distribution tab, and the install handlers
  // are what give the header its controls — so wiring spies at the meta level
  // would hand every story affordances its own story already covers.
  argTypes: {
    // Replaces the read-only Contents list, so it renders as given.
    contentsSlot: { control: false, table: { category: "Content" } },
    context: { control: "object", table: { category: "Data" } },
    disambiguator: { control: "text", table: { category: "Content" } },
    headerActions: { control: false, table: { category: "Content" } },
    installError: { control: "text", table: { category: "State" } },
    installPending: { control: "object", table: { category: "State" } },
    memberTargetsDescription: {
      control: "text",
      table: { category: "Content" },
    },
    memberTargetsError: { control: "boolean", table: { category: "State" } },
    // Presence turns the read-only member per-machine list into an actionable
    // one, so this is data plus a handler rather than a plain fixture.
    memberTargetsInstall: { control: false, table: { category: "Data" } },
    memberTargetsLoading: { control: "boolean", table: { category: "State" } },
    onInstall: { control: false, table: { category: "Events" } },
    onManageDistribution: { control: false, table: { category: "Events" } },
    onUninstall: { control: false, table: { category: "Events" } },
    onUpdate: { control: false, table: { category: "Events" } },
    onWithdrawDistribution: { control: false, table: { category: "Events" } },
    pack: { control: "object", table: { category: "Data" } },
    withdrawDistributionPending: {
      control: "boolean",
      table: { category: "State" },
    },
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof PackDetail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DesktopTeam: Story = {};

export const DesktopSolo: Story = {
  args: {
    context: createPacksContext(PacksMode.DesktopSolo),
  },
};

export const WebAdmin: Story = {
  args: {
    context: createPacksContext(PacksMode.WebAdmin),
  },
};

/**
 * ISS-5125 — the member per-machine block with its ACT half attached.
 *
 * `MemberInstallControl` has isolated stories of its own, but a control that
 * looks right alone can still land wrong in the block that composes it: the
 * per-machine grid grows a THIRD column only when `install` is present
 * (`grid-cols-[auto_auto_auto]` vs `grid-cols-[auto_auto]`), and the states a
 * member actually sees are MIXED down the column — one machine mid-dispatch, its
 * neighbour carrying a settled failure, a third offline with no button at all.
 * That vertical alignment is a property of the composition, so it needs a story
 * at this level; the child's stories cannot show it.
 */
const MEMBER_HARNESS = "claude";

function memberCell(
  computeTargetId: string,
  computeTargetName: string,
  state: PackInstallState
): PackComponentInstallMatrix["cells"][number] {
  return {
    computeTargetId,
    computeTargetName,
    harness: MEMBER_HARNESS,
    state,
    installedVersion: null,
    failureReason: null,
  };
}

const memberPack: PackView = {
  id: "pack-member",
  name: "release-captain",
  verified: false,
  harnesses: [MEMBER_HARNESS],
  installedHarnesses: [],
  installedByMe: false,
  contents: [],
  installMatrix: [
    {
      componentId: "pack-member",
      componentName: "release-captain",
      cells: [
        memberCell("target-1", "mbp-laptop", PackInstallState.NotInstalled),
        memberCell("target-2", "desk-tower", PackInstallState.NotInstalled),
        memberCell("target-3", "ci-runner", PackInstallState.Offline),
      ],
    },
  ],
};

export const WebMemberInstall: Story = {
  args: {
    context: createPacksContext(PacksMode.WebMember),
    pack: memberPack,
    memberTargetsInstall: {
      onInstall: () => {
        // Storybook is presentational: the dispatch itself belongs to
        // `useMemberTargetsInstall`, which has its own tests.
      },
      // mbp-laptop is mid-dispatch…
      pendingCellKeys: [memberInstallCellKey("target-1", MEMBER_HARNESS)],
      // …while desk-tower already carries a settled, retryable failure and
      // ci-runner (offline) has no control at all. Three different row shapes
      // stacked, which is exactly the alignment this story exists to show.
      dispatchByCellKey: {
        [memberInstallCellKey("target-2", MEMBER_HARNESS)]: {
          message:
            "We couldn't start the install on desk-tower. Nothing was installed.",
          tone: MemberInstallDispatchTone.Danger,
          retryable: true,
        },
      },
    },
  },
};

/**
 * The same pack with an UNCONFIRMED outcome — the state that deliberately
 * withdraws the button rather than offering a retry that could install twice.
 * Paired with the story above so the two treatments can be compared directly.
 */
export const WebMemberInstallUnconfirmed: Story = {
  args: {
    context: createPacksContext(PacksMode.WebMember),
    pack: memberPack,
    memberTargetsInstall: {
      onInstall: () => {
        // See above.
      },
      dispatchByCellKey: {
        [memberInstallCellKey("target-1", MEMBER_HARNESS)]: {
          message:
            "Install sent to mbp-laptop. We couldn't confirm it started — this machine will report back when it does.",
          tone: MemberInstallDispatchTone.Pending,
          retryable: false,
        },
      },
    },
  },
};

/**
 * ISS-5123: the admin Distribution tab with the withdraw affordance on. Only
 * the WebAdmin context renders the tab at all, and the control appears only
 * when the surface supplies `onWithdrawDistribution` — which the production
 * surface does solely behind the closed-by-default `pack-undistribute` flag.
 * `mockPackViews[0]` carries a distribution, so there is something to withdraw.
 */
export const WebAdminWithdrawable: Story = {
  args: {
    context: createPacksContext(PacksMode.WebAdmin),
    onWithdrawDistribution: () => {
      // Presentational story: the real surface opens a confirmation here.
    },
  },
};

/** The in-flight state, where the control is disabled against a second click. */
export const WebAdminWithdrawPending: Story = {
  args: {
    context: createPacksContext(PacksMode.WebAdmin),
    onWithdrawDistribution: () => {
      // Presentational story: the real surface opens a confirmation here.
    },
    withdrawDistributionPending: true,
  },
};
