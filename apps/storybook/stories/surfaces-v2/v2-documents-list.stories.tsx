import { DOCUMENTS_LIST_DESIGN_ROWS } from "@repo/app/documents/components/list-design/documents-list-design-fixtures";
import { DocumentsListDesignPreview } from "@repo/app/documents/components/list-design/documents-list-design-preview";
import {
  DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { PlusIcon } from "lucide-react";
import { expect, within } from "storybook/test";
import DocumentsPage from "@/app/(authenticated)/[orgSlug]/documents/page";
import { Header } from "@/app/(authenticated)/components/header";
import {
  documentsListApiRoutes,
  documentsListFixture,
  documentsListRoutes,
} from "./fixtures/documents-list-fixtures";
import { LivePage } from "./live-page";
import {
  expectActiveNavItem,
  LIVE_ORG_SLUG,
  narrowStoryViewport,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 9 of 62: Documents List (Artifact list).
// Default and Dark are the Documents List design shell (ISS-12586, DI-16):
// the Branches list composition (toolbar, one count card, the table with the
// canonical artifact list cells, the pagination footer) with PRD-798's
// columns and fixture rows, in the app frame. No Type column; Related
// Sessions is an open question and is left out. The full page design is
// separate work.
//
// The `Live` stories are the page the live app ships today
// (`apps/app/.../documents/page.tsx`, header plus `DocumentsIndexSurface`) in
// the app frame. Live mounts the universal listing; Live Legacy preserves the
// previous listing. Each state uses the live page's own documents read.
// Before 2.0.31 they were Default, Loading, Empty, Error, Legacy and Narrow.

const meta = {
  title: "Surfaces/Labs/Documents/Documents List",
  tags: ["preview"],
  decorators: [withLiveRoute],
  render: () => (
    <LivePage activePath="/documents">
      <DocumentsListDesignPreview
        header={
          <Header breadcrumbs={[{ label: "Documents" }]}>
            {/* The live header's action, inert: the shell has no create flow. */}
            <Button type="button">
              <PlusIcon className="h-4 w-4" />
              Add document
            </Button>
          </Header>
        }
      />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: { path: `/${LIVE_ORG_SLUG}/documents` },
    appCore: {
      apiRoutes: documentsListApiRoutes,
      enabledFlags: [DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY],
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function documentsRead(respond: FixtureRoute["respond"], status?: number) {
  return {
    appCore: {
      apiRoutes: [
        { method: "GET", path: "/documents", respond, status },
        ...documentsListApiRoutes,
      ] satisfies FixtureRoute[],
    },
  };
}

const DESIGN_COLUMN_HEADERS = [
  "Document",
  "Owner",
  "Status",
  "Collaborators",
  "Comments",
  "Updated",
  "Current version",
  "Tags",
];

/** The page the live app ships today, in the documents route's frame. */
const live = {
  render: () => (
    <LivePage activePath="/documents">
      <DocumentsPage />
    </LivePage>
  ),
} satisfies Partial<Story>;

/**
 * The design shell: PRD-798's columns, one count card, no Type column.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of DESIGN_COLUMN_HEADERS) {
      await expect(
        canvas.getByRole("columnheader", { name })
      ).toBeInTheDocument();
    }
    await expect(
      canvas.queryByRole("columnheader", { name: "Type" })
    ).toBeNull();
    const [first] = DOCUMENTS_LIST_DESIGN_ROWS;
    await expect(canvas.getByText(first?.document.title ?? "")).toBeVisible();
    await expectActiveNavItem(canvasElement, "Documents");
  },
};

/** The design shell in the dark theme. */
export const Dark: Story = { globals: { theme: "dark" } };

/** The page the live app ships today. */
export const Live: Story = {
  ...live,
  parameters: { appCore: { apiRoutes: documentsListRoutes() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [first] = documentsListFixture;
    await expect(
      await canvas.findByText(first?.title ?? "", {}, { timeout: 10_000 })
    ).toBeVisible();
    await expectActiveNavItem(canvasElement, "Documents");
    await expect(
      canvas.getByRole("button", { name: "Add document" })
    ).toBeVisible();
  },
};

/** The documents read is still in flight. */
export const LiveLoading: Story = {
  ...live,
  parameters: documentsRead(() => new Promise(() => undefined)),
};

/** The workspace has no project-less documents yet. */
export const LiveEmpty: Story = {
  ...live,
  parameters: { appCore: { apiRoutes: documentsListRoutes([]) } },
};

/** The documents read failed. */
export const LiveError: Story = {
  ...live,
  parameters: documentsRead(() => null, 500),
};

export const LiveLegacy: Story = {
  ...live,
  parameters: { appCore: { enabledFlags: [] } },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText(documentsListFixture[0]?.title ?? "")
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "New Document" })
    ).toBeVisible();
  },
};

export const LiveNarrow: Story = {
  ...live,
  beforeEach: narrowStoryViewport,
  globals: { viewport: { value: "390-844" } },
  parameters: {
    appCore: {
      apiRoutes: documentsListRoutes(),
      enabledFlags: [
        DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY,
        GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        "columnheader",
        { name: "Name" },
        { timeout: 10_000 }
      )
    ).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    await expect(
      canvas.queryByRole("columnheader", { name: "Status" })
    ).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="card"]')).toBeNull();
  },
};
