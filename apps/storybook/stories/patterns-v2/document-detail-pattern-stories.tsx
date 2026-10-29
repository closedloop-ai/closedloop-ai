import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { DocumentDetailLayout } from "./document-detail-layout";

/**
 * The stories every live document editor pattern has (ISS-12171): the layout
 * opened on each tab, then dark. PRD and Plan Detail export them under their
 * own titles, so the two pages stay one layout.
 */
type DetailPatternStory = StoryObj;

/**
 * Every document detail pattern's meta: the layout, fullscreen, no controls.
 * Each file sets `tags` itself: the static story indexer does not read a spread.
 */
export const documentDetailPatternMeta = {
  render: () => <DocumentDetailLayout />,
  parameters: { layout: "fullscreen", controls: { disable: true } },
};

/** Opened on Artifact: the four tabs, the header row and the comments rail. */
export const documentDetailDefault: DetailPatternStory = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("tab").map((tab) => tab.textContent)
    ).toEqual(["Artifact", "Sessions", "Details", "Activity"]);
    await expect(canvas.getByTestId("panel-artifact")).toBeVisible();
    await expect(canvas.getByTestId("rail-content")).toBeVisible();
    await expect(canvas.getByTestId("page-header-breadcrumbs")).toBeVisible();
    await expect(canvas.getByTestId("page-header-actions")).toBeVisible();
    await expect(
      canvas.getByTestId("page-header-comments-toggle")
    ).toBeVisible();
  },
};

export const documentDetailSessionsTab: DetailPatternStory = {
  render: () => (
    <DocumentDetailLayout initialTab={ArtifactDetailTab.Sessions} />
  ),
  play: async ({ canvasElement }) => {
    await expectTabOpen(canvasElement, "Sessions", ArtifactDetailTab.Sessions);
  },
};

/** Opened on Details: the feed rail stays beside it, as the scaffold mounts it. */
export const documentDetailDetailsTab: DetailPatternStory = {
  render: () => <DocumentDetailLayout initialTab={ArtifactDetailTab.Details} />,
  play: async ({ canvasElement }) => {
    await expectTabOpen(canvasElement, "Details", ArtifactDetailTab.Details);
    await expect(
      within(canvasElement).getByTestId("rail-content")
    ).toBeVisible();
  },
};

export const documentDetailActivityTab: DetailPatternStory = {
  render: () => (
    <DocumentDetailLayout initialTab={ArtifactDetailTab.Activity} />
  ),
  play: async ({ canvasElement }) => {
    await expectTabOpen(canvasElement, "Activity", ArtifactDetailTab.Activity);
  },
};

export const documentDetailDark: DetailPatternStory = {
  globals: { theme: "dark" },
};

async function expectTabOpen(
  canvasElement: HTMLElement,
  name: string,
  tab: ArtifactDetailTab
) {
  const canvas = within(canvasElement);
  await expect(
    canvas.getByRole("tab", { name, selected: true })
  ).toBeInTheDocument();
  await expect(canvas.getByTestId(`panel-${tab}`)).toBeVisible();
}
