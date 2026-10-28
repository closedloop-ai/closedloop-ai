import {
  ARTIFACT_DETAIL_TABS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import type { Meta, StoryObj } from "@storybook/react";
// `useArgs` only works called directly inside a story's own `render`
// function -- Storybook's hooks context is torn down by the time React gets
// to a nested child component, so it cannot live inside ShellHarness itself.
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, within } from "storybook/test";
import { ArtifactDetailShell } from "./artifact-detail-shell";
import {
  ACTIVITY_STATES,
  ActivityStateArg,
  LONG_PANEL_ROWS,
  ShellHarness,
} from "./artifact-detail-shell.story-fixtures";

/**
 * The promoted Artifact / Details / Sessions / Activity shell (ISS-10790),
 * the shared layout every artifact detail page is built inside (Patterns
 * v2.0/Shared/Artifact Detail). Default shows it as a pattern: every slot an
 * empty, named region. The other stories prove the shell's mechanics.
 * Content-free: every panel here is story-local fixture content standing in
 * for what a real host (the prototype today, Session/Branch adapters in
 * ISS-10796/10797) supplies through `panels`. The comments slot holds inline
 * fixture content, not the real rail, which is ISS-11209's and has its own
 * stories -- this file is about the shell's tab, state and mounting
 * mechanics, not any tab's content.
 *
 * Controls table:
 * | Prop / arg | Control | Why |
 * |---|---|---|
 * | activeTab | inline-radio | real 4-value union; two-way synced, so clicking a tab in the canvas moves the control too |
 * | tabs | check | the per-type availability set (Session has no Sessions tab) |
 * | headerActionsTabs | check | which tabs show the header actions |
 * | activityState | select | story-level: drives `tabStates.activity` through the three shell-owned states |
 * | onActiveTabChange | action | handler, not a control |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | comments | ReactNode mount point; the rail is ISS-11209's |
 * | headerActions, headerEnd | ReactNode slots supplied by the host |
 * | panels | ReactNode bodies; content belongs to ISS-10791/10792/10793 |
 * | tabListLabel | string with one sensible value; asserted in the play functions |
 * States a control cannot reach cleanly (keep-mounted, fallback, keyboard)
 * get their own fixed stories with play functions.
 */

type StoryArgs = React.ComponentProps<
  typeof ArtifactDetailShell<ArtifactDetailTab>
> & { activityState: ActivityStateArg };

const meta = {
  title: "Patterns/Shared/Artifact Detail",
  component: ArtifactDetailShell<ArtifactDetailTab>,
  tags: ["stable", "autodocs"],
  parameters: { layout: "fullscreen", controls: { expanded: true } },
  argTypes: {
    activeTab: {
      control: "inline-radio",
      options: ARTIFACT_DETAIL_TABS,
      table: { category: "Navigation" },
    },
    tabs: {
      control: "check",
      options: ARTIFACT_DETAIL_TABS,
      table: { category: "Navigation" },
    },
    headerActionsTabs: {
      control: "check",
      options: ARTIFACT_DETAIL_TABS,
      table: { category: "Header" },
    },
    activityState: {
      control: "select",
      options: Object.values(ActivityStateArg),
      table: { category: "States" },
    },
    onActiveTabChange: {
      action: "activeTabChange",
      table: { category: "Navigation" },
    },
    onActivePanelReady: { control: false, table: { category: "Navigation" } },
    comments: { control: false, table: { category: "Comments" } },
    headerActions: { control: false, table: { category: "Header" } },
    headerEnd: { control: false, table: { category: "Header" } },
    panels: { control: false, table: { category: "Content" } },
    tabListLabel: { control: false, table: { category: "Navigation" } },
    tabStates: { control: false, table: { category: "States" } },
  },
  args: {
    activeTab: ArtifactDetailTab.Artifact,
    activityState: ActivityStateArg.None,
    headerActionsTabs: [ArtifactDetailTab.Artifact],
    onActiveTabChange: fn(),
    panels: { activity: null, artifact: null, details: null, sessions: null },
    tabs: [...ARTIFACT_DETAIL_TABS],
  },
} satisfies Meta<StoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The playground: every control is live and two-way synced with the canvas.
 */
export const Default: Story = {
  render: () => {
    const [args, updateArgs] = useArgs<StoryArgs>();
    return (
      <ShellHarness
        activeTab={args.activeTab}
        activityState={args.activityState}
        headerActionsTabs={args.headerActionsTabs}
        layoutOnly
        onActiveTabChange={(tab) => {
          updateArgs({ activeTab: tab });
          args.onActiveTabChange(tab);
        }}
        tabs={args.tabs}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tablist", { name: "Artifact detail sections" })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("tab", { name: "Artifact", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByTestId("panel-artifact")).toBeVisible();
    await expect(canvas.getByTestId("header-actions")).toBeVisible();
    await expect(canvas.getByTestId("header-end")).toBeVisible();
    await expect(canvas.getByTestId("rail-content")).toBeVisible();
  },
};

export const ErrorNotice: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <ShellHarness
      activityState={ActivityStateArg.Error}
      initialTab={ArtifactDetailTab.Activity}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      ACTIVITY_STATES[ActivityStateArg.Error].title
    );
    await expect(canvas.getByTestId("panel-activity")).toBeVisible();
  },
};

/**
 * Partial or stale data about THIS tab: the body still renders, under a
 * notice at the host's chosen tone. A page-level alert stays above the shell.
 */
export const StaleNotice: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <ShellHarness
      activityState={ActivityStateArg.Stale}
      initialTab={ArtifactDetailTab.Activity}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(ACTIVITY_STATES[ActivityStateArg.Stale].title)
    ).toBeVisible();
    await expect(canvas.getByTestId("panel-activity")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible();
  },
};

export const PartialNotice: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <ShellHarness
      activityState={ActivityStateArg.Partial}
      initialTab={ArtifactDetailTab.Activity}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(ACTIVITY_STATES[ActivityStateArg.Partial].title)
    ).toBeVisible();
    await expect(canvas.getByTestId("panel-activity")).toBeVisible();
  },
};

/**
 * Branch Activity before ISS-10980 connects it: the tab stays in the bar and says it is not connected, which reads differently
 * from an empty successful result.
 */
export const ActivityUnsupported: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness activityState={ActivityStateArg.Unsupported} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Activity" }));
    await expect(
      canvas.getByText(ACTIVITY_STATES[ActivityStateArg.Unsupported].title)
    ).toBeVisible();
    await expect(
      canvas.queryByTestId("panel-activity")
    ).not.toBeInTheDocument();
  },
};

export const DarkTheme: Story = {
  ...Default,
  globals: { theme: "dark" },
};

/**
 * Header actions follow the host's `headerActionsTabs`, not a hard-coded
 * tab. Here the host shows them on Artifact and Sessions only.
 */
export const HeaderActionsOnConfiguredTabs: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <ShellHarness
      headerActionsTabs={[
        ArtifactDetailTab.Artifact,
        ArtifactDetailTab.Sessions,
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Refresh" })).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Details" }));
    await expect(
      canvas.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument();
    await expect(canvas.getByTestId("header-end")).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Sessions" }));
    await expect(canvas.getByRole("button", { name: "Refresh" })).toBeVisible();
  },
};

/**
 * The comments slot is a mount point: this host mounts nothing on Details,
 * and the shell has no opinion about it.
 */
export const CommentsMountPointPerTab: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("rail-content")).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Details" }));
    await expect(canvas.queryByTestId("rail-content")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("tab", { name: "Sessions" }));
    await expect(canvas.getByTestId("rail-content")).toBeVisible();
  },
};

/**
 * A tab keeps its state once opened: type into the Sessions fixture, leave,
 * come back, and the text is still there (the selected PR, trace scroll and
 * playhead survive the same way in production).
 */
export const KeepsVisitedTabState: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness keepMountedTabs={[ArtifactDetailTab.Sessions]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Sessions" }));
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Sessions note" }),
      "keep me"
    );
    await userEvent.click(canvas.getByRole("tab", { name: "Details" }));
    await expect(canvas.getByTestId("panel-sessions")).not.toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Sessions" }));
    await expect(
      canvas.getByRole("textbox", { name: "Sessions note" })
    ).toHaveValue("keep me");
  },
};

/**
 * The design-system tab primitives' own keyboard model, asserted rather than
 * assumed. ISS-10795's focus and overflow are covered by the shell tests and
 * browser spec.
 */
export const KeyboardTabNavigation: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("tab", { name: "Artifact" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    // Sessions is the second tab since ISS-12167.
    const sessionsTab = canvas.getByRole("tab", {
      name: "Sessions",
      selected: true,
    });
    await expect(sessionsTab).toHaveFocus();
    await expect(canvas.getByTestId("panel-sessions")).toBeVisible();
  },
};

/**
 * A tab the user left unmounts by default, as today's Session and Branch
 * pages do; only `keepMountedTabs` keeps one alive.
 */
export const UnmountsInactiveTabByDefault: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Sessions" }));
    await userEvent.click(canvas.getByRole("tab", { name: "Details" }));
    await expect(canvas.queryByTestId("panel-sessions")).toBeNull();
  },
};

/**
 * Session's header set (Refresh / Copy ID / Copy URL) plus `headerEnd` at
 * phone width: the header wraps the actions onto their own row instead of
 * overflowing the tab bar (ISS-10790 AC 3).
 */
export const LongHeaderActionsNarrow: Story = {
  parameters: { controls: { disable: true } },
  globals: { viewport: { value: "390-844" } },
  render: () => <ShellHarness longHeaderActions />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["Refresh", "Copy ID", "Copy URL"]) {
      await expect(canvas.getByRole("button", { name })).toBeVisible();
    }
    await expect(canvas.getByTestId("header-end")).toBeVisible();
  },
};

/**
 * Keyboard focus on the SELECTED tab: the focus ring (design-system
 * `focus-visible:ring`) shows on top of the selected underline, so focused
 * and selected read as two different states. Tab in from the button above.
 *
 * This `play` asserts focus and selection only: its runner, the jsdom story
 * sweep, loads no CSS. The visual difference (ring, underline, muted text) is
 * asserted on computed styles in a real browser by
 * `e2e/artifact-detail-shell.local-trusted.spec.ts`.
 */
export const FocusVisibleOnSelectedTab: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col">
      <button
        className="m-2 self-start rounded border px-2 py-1 text-sm"
        type="button"
      >
        Before the shell
      </button>
      <ShellHarness />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "Before the shell" }).focus();
    await userEvent.tab();
    const selected = canvas.getByRole("tab", {
      name: "Artifact",
      selected: true,
    });
    await expect(selected).toHaveFocus();
    await expect(
      canvas.getByRole("tab", { name: "Details", selected: false })
    ).not.toHaveFocus();
  },
};

export const FocusVisibleOnSelectedTabDark: Story = {
  ...FocusVisibleOnSelectedTab,
  globals: { theme: "dark" },
};

export const Narrow: Story = {
  parameters: { controls: { disable: true } },
  globals: { viewport: { value: "390-844" } },
  render: () => <ShellHarness />,
};

export const NarrowDark: Story = {
  ...Narrow,
  globals: { theme: "dark", viewport: { value: "390-844" } },
};

export const RailClosed: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness railOpen={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByTestId("rail-content")).not.toBeInTheDocument();
    await expect(canvas.getByTestId("panel-artifact")).toBeVisible();
  },
};

/**
 * A tab body taller than the shell (ISS-10790 AC 3, "panel scroll"): the body
 * scrolls inside the panel and the tab bar and header actions stay where they
 * are. jsdom has no layout, so this `play` checks only that the rows render;
 * the scrolling itself is asserted in a real browser by
 * `e2e/artifact-detail-shell.local-trusted.spec.ts`, at wide and narrow widths.
 */
export const LongPanelScrolls: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness longPanel />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(LONG_PANEL_ROWS[0] ?? "")
    ).toBeInTheDocument();
    await expect(
      canvas.getByText(LONG_PANEL_ROWS.at(-1) ?? "")
    ).toBeInTheDocument();
  },
};

/** A cold selection tests visibility without an initial focus transfer (ISS-10795). */
export const ColdActivityDeepLink: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ShellHarness initialTab={ArtifactDetailTab.Activity} />,
};
