import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import {
  ShellHarness,
  TallShellHarness,
} from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell.story-fixtures";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
import {
  SESSION_ARTIFACT_ROUTE_CONFIG,
  SESSION_ARTIFACT_TAB_LABELS,
} from "./session-artifact-routing";

/**
 * Patterns: the Session Detail page's layout. It is the ISS-10790
 * artifact detail shell with the Session tab set from the same route
 * configuration both hosts use, and every slot left as an empty, named
 * region: a pattern shows where content goes, never the content. The
 * finished page, built from this layout and the Composites sections, is
 * Surfaces/Artifacts/Sessions/Session Detail.
 *
 * The page header row above the tabs holds the breadcrumbs and, beside the
 * comments rail, the comments toggle; the tab row ends with the collaborators
 * (the web-master generic artifact prototype's layout).
 *
 * Narrow keeps the shell's fixture header actions: it proves the tab strip
 * scrolls when the header is crowded (e2e/artifact-detail-shell spec).
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const meta = {
  title: "Patterns/Artifacts/Sessions/Session Detail",
  tags: ["stable"],
  component: ArtifactDetailShell<SessionTab>,
  args: {
    activeTab: ArtifactDetailTab.Sessions,
    onActiveTabChange: fn(),
    panels: {
      [ArtifactDetailTab.Sessions]: null,
      [ArtifactDetailTab.Details]: null,
      [ArtifactDetailTab.Activity]: null,
    },
    tabLabels: SESSION_ARTIFACT_TAB_LABELS,
    tabs: SESSION_ARTIFACT_ROUTE_CONFIG.tabs,
  },
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof ArtifactDetailShell<SessionTab>>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The tab row's end holds the page's collaborators (PRD-751). */
const COLLABORATORS_REGION = "Collaborators";

/** The tabs the comments rail sits beside on this page, as its host decides. */
const RAIL_TABS = [ArtifactDetailTab.Sessions] as const;

/**
 * Session detail's tab set (ISS-12167, operator 2026-10-07): Session /
 * Details / Activity. A Session hides the generic Artifact tab entirely — no
 * trigger, no disabled state, no body — and the Sessions tab it keeps reads
 * singular, because the page holds exactly one session.
 */
export const Default: Story = {
  render: () => (
    <ShellHarness
      headerActionsTabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
      headerEndLabel={COLLABORATORS_REGION}
      initialTab={ArtifactDetailTab.Sessions}
      layoutOnly
      pageHeader
      railTabs={RAIL_TABS}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("tab").map((tab) => tab.textContent)
    ).toEqual(["Session", "Details", "Activity"]);
    await expect(
      canvas.queryByRole("tab", { name: "Artifact" })
    ).not.toBeInTheDocument();
    await expect(canvas.getByTestId("panel-sessions")).toBeVisible();
    await expect(canvas.getByTestId("rail-content")).toBeVisible();
    await expect(canvas.getByTestId("page-header-breadcrumbs")).toBeVisible();
    await expect(
      canvas.getByTestId("page-header-comments-toggle")
    ).toBeVisible();
    await expect(canvas.getByTestId("header-end")).toHaveTextContent(
      COLLABORATORS_REGION
    );
  },
};

/** Opened on Details: no comments rail beside it. */
export const DetailsTab: Story = {
  render: () => (
    <ShellHarness
      headerActionsTabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
      headerEndLabel={COLLABORATORS_REGION}
      initialTab={ArtifactDetailTab.Details}
      layoutOnly
      pageHeader
      railTabs={RAIL_TABS}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Details", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByTestId("panel-details")).toBeVisible();
    await expect(canvas.queryByTestId("rail-content")).toBeNull();
    await expect(
      canvas.queryByTestId("page-header-comments-toggle")
    ).toBeNull();
  },
};

/** Opened on Activity: no comments rail beside it. */
export const ActivityTab: Story = {
  render: () => (
    <ShellHarness
      headerActionsTabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
      headerEndLabel={COLLABORATORS_REGION}
      initialTab={ArtifactDetailTab.Activity}
      layoutOnly
      pageHeader
      railTabs={RAIL_TABS}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Activity", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByTestId("panel-activity")).toBeVisible();
    await expect(canvas.queryByTestId("rail-content")).toBeNull();
  },
};

/**
 * A bad `activeTab` (here Artifact, which a Session page no longer configures)
 * falls back to the first configured tab and never reveals the missing one.
 * URL aliases are ISS-10795's and resolve before this guard.
 */
export const InvalidTabFallsBack: Story = {
  render: () => (
    <ShellHarness
      headerActionsTabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
      headerEndLabel={COLLABORATORS_REGION}
      initialTab={ArtifactDetailTab.Artifact}
      layoutOnly
      pageHeader
      railTabs={RAIL_TABS}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Session", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByTestId("panel-sessions")).toBeVisible();
  },
};

/** A crowded header at narrow width: the tab strip scrolls, it never wraps. */
export const Narrow: Story = {
  render: () => (
    <ShellHarness
      initialTab={ArtifactDetailTab.Sessions}
      longHeaderActions
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
};

/** Opened on Activity by a deep link, without taking focus. */
export const ColdActivityDeepLink: Story = {
  render: () => (
    <ShellHarness
      headerActionsTabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
      headerEndLabel={COLLABORATORS_REGION}
      initialTab={ArtifactDetailTab.Activity}
      layoutOnly
      pageHeader
      railTabs={RAIL_TABS}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
};

/** The same deep link on a host whose tab strip starts below the fold. */
export const ColdActivityBelowFold: Story = {
  render: () => (
    <TallShellHarness
      headerActionsTabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
      headerEndLabel={COLLABORATORS_REGION}
      initialTab={ArtifactDetailTab.Activity}
      layoutOnly
      pageHeader
      railTabs={RAIL_TABS}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
};

export const Dark: Story = {
  render: () => (
    <ShellHarness
      headerActionsTabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
      headerEndLabel={COLLABORATORS_REGION}
      initialTab={ArtifactDetailTab.Sessions}
      layoutOnly
      pageHeader
      railTabs={RAIL_TABS}
      tabLabels={SESSION_ARTIFACT_TAB_LABELS}
      tabs={SESSION_ARTIFACT_ROUTE_CONFIG.tabs}
    />
  ),
  globals: { theme: "dark" },
};

type SessionTab = (typeof SESSION_ARTIFACT_ROUTE_CONFIG.tabs)[number];
