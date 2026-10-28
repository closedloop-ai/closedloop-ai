import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { StoryObj } from "@storybook/react";
import type { ReactElement } from "react";
import { expect, within } from "storybook/test";
import {
  CANVAS_REGIONS,
  type DocumentFamilyCanvas,
  DocumentFamilyDetailLayout,
} from "./document-family-detail-layout";

/**
 * The stories the Labs Document and Issue Detail patterns share (ISS-12586,
 * ISS-12576): the layout opened on each tab, then dark. Each file builds them
 * for its own canvas.
 */
type DetailPatternStory = StoryObj;

type Stories = {
  meta: {
    render: () => ReactElement;
    parameters: { layout: "fullscreen"; controls: { disable: true } };
  };
  Default: DetailPatternStory;
  SessionsTab: DetailPatternStory;
  DetailsTab: DetailPatternStory;
  ActivityTab: DetailPatternStory;
  Dark: DetailPatternStory;
};

/**
 * Every story for one canvas. Each file sets `tags` itself: the static story
 * indexer does not read a spread.
 */
export function documentFamilyDetailStories(
  canvas: DocumentFamilyCanvas
): Stories {
  return {
    meta: {
      render: () => <DocumentFamilyDetailLayout canvas={canvas} />,
      parameters: { layout: "fullscreen", controls: { disable: true } },
    },
    /**
     * Opened on Artifact: the header row with the comments toggle, the tab
     * row ending with the collaborators, the canvas's regions in order and
     * the comments rail.
     */
    Default: {
      play: async ({ canvasElement }) => {
        const view = within(canvasElement);
        await expect(
          view.getAllByRole("tab").map((tab) => tab.textContent)
        ).toEqual(["Artifact", "Sessions", "Details", "Activity"]);
        await expect(view.getByTestId("page-header-breadcrumbs")).toBeVisible();
        await expect(
          view.getByTestId("page-header-comments-toggle")
        ).toBeVisible();
        await expect(view.getByTestId("page-header-add-comment")).toBeVisible();
        await expect(view.getByTestId("tab-row-collaborators")).toBeVisible();
        await expect(view.getByTestId("rail-content")).toBeVisible();
        const [top, ...rest] = CANVAS_REGIONS[canvas];
        await expect(view.getByTestId("canvas-top")).toHaveTextContent(
          top ?? ""
        );
        await expect(
          view
            .getAllByTestId("canvas-region")
            .map((region) => region.textContent)
        ).toEqual(rest);
        // Both canvases' toolbars stay at the top while the canvas scrolls.
        await expect(view.getByTestId("canvas-top")).toHaveClass("sticky");
      },
    },
    /** Opened on Sessions: the rail and the toggle stay; Add comment goes. */
    SessionsTab: {
      render: () => (
        <DocumentFamilyDetailLayout
          canvas={canvas}
          initialTab={ArtifactDetailTab.Sessions}
        />
      ),
      play: async ({ canvasElement }) => {
        await expectTabOpen(canvasElement, "Sessions");
        await expect(
          within(canvasElement).getByTestId("rail-content")
        ).toBeVisible();
        await expect(
          within(canvasElement).queryByTestId("page-header-add-comment")
        ).toBeNull();
      },
    },
    /** Opened on Details: no rail and no comments toggle. */
    DetailsTab: {
      render: () => (
        <DocumentFamilyDetailLayout
          canvas={canvas}
          initialTab={ArtifactDetailTab.Details}
        />
      ),
      play: async ({ canvasElement }) => {
        await expectTabOpen(canvasElement, "Details");
        await expectNoRail(canvasElement);
      },
    },
    /** Opened on Activity: no rail and no comments toggle. */
    ActivityTab: {
      render: () => (
        <DocumentFamilyDetailLayout
          canvas={canvas}
          initialTab={ArtifactDetailTab.Activity}
        />
      ),
      play: async ({ canvasElement }) => {
        await expectTabOpen(canvasElement, "Activity");
        await expectNoRail(canvasElement);
      },
    },
    Dark: { globals: { theme: "dark" } },
  };
}

async function expectTabOpen(canvasElement: HTMLElement, name: string) {
  const view = within(canvasElement);
  await expect(
    view.getByRole("tab", { name, selected: true })
  ).toBeInTheDocument();
  await expect(view.getByTestId(`panel-${name.toLowerCase()}`)).toBeVisible();
  // The canvas and its toolbar are on the Artifact tab only.
  await expect(view.queryByTestId("canvas-top")).toBeNull();
}

async function expectNoRail(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await expect(view.queryByTestId("rail-content")).toBeNull();
  await expect(view.queryByTestId("page-header-comments-toggle")).toBeNull();
  await expect(view.queryByTestId("page-header-add-comment")).toBeNull();
}
