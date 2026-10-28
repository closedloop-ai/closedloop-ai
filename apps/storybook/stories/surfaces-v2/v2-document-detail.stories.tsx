import { DocumentStatus } from "@repo/api/src/types/document";
import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { DOCUMENT_DESIGN_ARTIFACT } from "@repo/app/documents/components/detail-design/document-detail-design-fixtures";
import { DocumentDetailDesignPreview } from "@repo/app/documents/components/detail-design/document-detail-design-preview";
import type { DocumentDesignTab } from "@repo/app/documents/components/detail-design/document-detail-design-shell";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { DocumentEditorContainer } from "@/app/(authenticated)/[orgSlug]/documents/[slug]/document-editor-container";
import { DocumentDetailPageHeader } from "../composites-v2/v2-artifact-detail-page-header";
import { DocumentRoutePage, documentRoute } from "./document-route-page";
import {
  docDetailFixture,
  documentDetailRoutes,
  olderVersionOf,
} from "./fixtures/document-detail-fixtures";
import { LivePage } from "./live-page";
import { expectActiveNavItem, withLiveRoute } from "./live-route";

// ISS-11361 Target sidebar, entry 10 of 62: Document Detail (Document editor).
// Default and the tab stories are the PRD-751 Document detail shell
// (ISS-12586, DI-16): Patterns's artifact detail shell with the shipped
// tab set (Artifact / Sessions / Details / Activity), filled with the
// Composites sections under Labs/Documents/Document Detail and fixture
// data, in the app frame, as Branch and Session Detail are. The comments rail
// sits beside Artifact and Sessions, Branch's rule.
//
// The `Live` stories are the page the live app ships today
// (`apps/app/.../[orgSlug]/documents/[slug]/page.tsx`: `DocumentEditorContainer`)
// in the app frame: the header with Actions, the metadata bar, the editor and
// the sections under it. Each is one state the page reaches from its reads
// or its `?version=`. Before 2.0.31 they were Default, Fresh Blank Document
// and Historical Version.
//
// The editor's Liveblocks room is replaced by the room-less branch
// (.storybook/collaboration-room-utils-mock.ts), so presence, anchored
// comments and the feed rail are not shown.
// The server reads the document before it renders and hands it to the
// container; here the container reads it itself, so the page settles a moment
// later on the same document. The live page has no loading state of its own.

const meta = {
  title: "Surfaces/Labs/Documents/Document Detail",
  tags: ["preview"],
  decorators: [withLiveRoute],
  render: () => <DocumentDesignPage tab={ArtifactDetailTab.Artifact} />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: documentRoute("documents", docDetailFixture.slug),
    appCore: { apiRoutes: documentDetailRoutes(docDetailFixture) },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const COMMENTS_RAIL = { name: "Comments" } as const;
const COMMENTS_TOGGLE_RE = /comments rail$/;
const PAGE_TITLE = `${DOCUMENT_DESIGN_ARTIFACT.slug} ${DOCUMENT_DESIGN_ARTIFACT.title}`;

/** The people and projects the PRD-751 page's Activity rows name. */
const design = {
  parameters: { appCore: { queryData: ACTIVITY_QUERY_DATA } },
} as const;

/** The PRD-751 page, opened on `tab`, in the app frame. */
function DocumentDesignPage({ tab }: { tab: DocumentDesignTab }) {
  return (
    <LivePage activePath="/documents">
      <DocumentDetailDesignPreview
        initialTab={tab}
        pageHeader={DocumentDetailPageHeader}
      />
    </LivePage>
  );
}

/** The page the live app ships today, in the document route's frame. */
const live = {
  render: () => (
    <DocumentRoutePage
      activePath="/documents"
      container={DocumentEditorContainer}
      slug={docDetailFixture.slug}
    />
  ),
} satisfies Partial<Story>;

/**
 * The page on Artifact: Add comment just before the comments toggle in the
 * header; the document canvas (the toolbar the Issue page has too: the live
 * editor's text controls, always on, and the version dropdown; then the
 * body at its natural height) with the comments rail beside it. The tab
 * row is in the shipped order and the rail follows Branch's per-tab rule.
 */
export const Default: Story = {
  ...design,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tablist = canvas.getByRole("tablist", {
      name: "Artifact detail sections",
    });
    await expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["Artifact", "Sessions", "Details", "Activity"]);
    await expect(
      canvas.getByRole("heading", { level: 1, name: PAGE_TITLE })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Add comment" })
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Select version" })
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Bold" })).toBeVisible();
    await expect(
      canvas.getByRole("complementary", COMMENTS_RAIL)
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: COMMENTS_TOGGLE_RE })
    ).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("tab", { name: "Details" }));
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();
    await userEvent.click(canvas.getByRole("tab", { name: "Artifact" }));
    await expectActiveNavItem(canvasElement, "Documents");
  },
};

/** Opened on Sessions: the sessions that wrote to or commented on it. */
export const SessionsTab: Story = {
  ...design,
  render: () => <DocumentDesignPage tab={ArtifactDetailTab.Sessions} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Sessions", selected: true })
    ).toBeInTheDocument();
    // Beside Sessions the rail holds the session comments, as on Branch.
    await expect(
      canvas.getByRole("complementary", { name: "Session comments" })
    ).toBeInTheDocument();
  },
};

/**
 * Opened on Details: Artifact details, Document details (Current version
 * alone, PRD-799), Custom fields and Associated artifacts. No comments rail.
 */
export const DetailsTab: Story = {
  ...design,
  render: () => <DocumentDesignPage tab={ArtifactDetailTab.Details} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Details", selected: true })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("group", { name: "Current version" })
    ).toBeVisible();
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();
  },
};

/** Opened on Activity: the Document feed, newest first. No comments rail. */
export const ActivityTab: Story = {
  ...design,
  render: () => <DocumentDesignPage tab={ArtifactDetailTab.Activity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Activity", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByRole("list", { name: "Activity" })).toBeVisible();
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();
  },
};

/** The page in the dark theme. */
export const Dark: Story = {
  ...design,
  globals: { theme: "dark" },
};

/** The page the live app ships today. */
export const Live: Story = {
  ...live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The full jsdom sweep can hold a second matching heading, so any one
    // visible title is enough.
    const titles = await canvas.findAllByRole(
      "heading",
      { level: 1, name: docDetailFixture.title },
      { timeout: 10_000 }
    );
    await expect(titles[0]).toBeVisible();
    await expectActiveNavItem(canvasElement, "Documents");
  },
};

/** A document just created: a draft with nothing written yet. */
export const LiveFreshBlankDocument: Story = {
  ...live,
  parameters: {
    appCore: {
      apiRoutes: documentDetailRoutes({
        ...docDetailFixture,
        latestVersion: 1,
        latestVersionContent: "",
        status: DocumentStatus.Draft,
        title: "Release checklist",
        version: { ...docDetailFixture.version, content: "", version: 1 },
      }),
    },
  },
};

/** An earlier version, opened from the version history (`?version=1`). */
export const LiveHistoricalVersion: Story = {
  ...live,
  parameters: {
    liveRoute: documentRoute("documents", docDetailFixture.slug, 1),
    appCore: {
      apiRoutes: documentDetailRoutes(docDetailFixture, {
        versions: {
          1: olderVersionOf(
            docDetailFixture,
            1,
            "# Engineering onboarding guide\n\n## First day\n- Get access to GitHub.\n"
          ),
        },
      }),
    },
  },
};
