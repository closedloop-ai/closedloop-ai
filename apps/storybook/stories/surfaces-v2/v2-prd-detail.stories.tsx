import { DocumentStatus } from "@repo/api/src/types/document";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { DocumentEditorContainer } from "@/app/(authenticated)/[orgSlug]/documents/[slug]/document-editor-container";
import { DocumentRoutePage, documentRoute } from "./document-route-page";
import {
  documentDetailRoutes,
  olderVersionOf,
  pendingBySlugRoute,
  prdDetailFixture,
} from "./fixtures/document-detail-fixtures";
import { withLiveRoute } from "./live-route";

// ISS-11361 Target sidebar, entry 37 of 62: PRD Detail (Document editor).
// The live route's own page (`apps/app/.../[orgSlug]/documents/[slug]/page.tsx`:
// `DocumentEditorContainer`) in the app frame: the header, the metadata bar,
// the editor and the sections under it. Each story is one state the page
// reaches from its reads or its `?version=`.
//
// The editor's Liveblocks room is replaced by the room-less branch
// (.storybook/collaboration-room-utils-mock.ts), so presence, anchored
// comments and the feed rail are not shown.

const meta = {
  title: "Surfaces/Other Pages/PRDs/PRD Detail",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => (
    <DocumentRoutePage
      activePath="/prds"
      container={DocumentEditorContainer}
      slug={prdDetailFixture.slug}
    />
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: documentRoute("prds", prdDetailFixture.slug),
    appCore: { apiRoutes: documentDetailRoutes(prdDetailFixture) },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The full jsdom sweep can hold a second matching heading, so any one
    // visible title is enough.
    const titles = await canvas.findAllByRole(
      "heading",
      { level: 1, name: prdDetailFixture.title },
      { timeout: 10_000 }
    );
    await expect(titles[0]).toBeVisible();
  },
};

/** The artifact read is still in flight. */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        pendingBySlugRoute(prdDetailFixture),
        ...documentDetailRoutes(prdDetailFixture),
      ],
    },
  },
};

/** A draft PRD the agent has just generated. */
export const FreshlyGenerated: Story = {
  parameters: {
    appCore: {
      apiRoutes: documentDetailRoutes({
        ...prdDetailFixture,
        latestVersion: 1,
        status: DocumentStatus.Draft,
        version: { ...prdDetailFixture.version, version: 1 },
      }),
    },
  },
};

/** An earlier version, opened from the version history (`?version=1`). */
export const HistoricalVersion: Story = {
  parameters: {
    liveRoute: documentRoute("prds", prdDetailFixture.slug, 1),
    appCore: {
      apiRoutes: documentDetailRoutes(prdDetailFixture, {
        versions: {
          1: olderVersionOf(
            prdDetailFixture,
            1,
            "# Session trace timeline\n\n## Problem\nReviewers cannot see an agent branch in one place.\n"
          ),
        },
      }),
    },
  },
};
