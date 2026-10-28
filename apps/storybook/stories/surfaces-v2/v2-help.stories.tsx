import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import HelpPage from "@/app/(authenticated)/[orgSlug]/help/page";
import {
  type DocsHelpCorpus,
  DocsHelpFetch,
  docsNavFixture,
} from "./fixtures/help-fixtures";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar: Help (Docs reader).
// The live route's own page (`apps/app/.../help/page.tsx`: the
// `labs-nav-section` and `help-complete-surface` route gates, the Header and
// `WebHelpSurfaceHost`) in the app frame. The route renders nothing but its
// fallback chrome unless both gates are open, so both are on here. Each story
// is one state the page reaches from its docs-corpus reads.

const READY: DocsHelpCorpus = { nav: "ok" };

const FIRST_PAGE = docsNavFixture[0]?.pages[0];
const SECOND_PAGE = docsNavFixture[0]?.pages[1];

const meta = {
  title: "Surfaces/Other Pages/Help",
  tags: ["stable"],
  render: (_args, { parameters }) => (
    <DocsHelpFetch
      corpus={(parameters.docsHelp as DocsHelpCorpus | undefined) ?? READY}
    >
      <LivePage activePath="/help">
        <HelpPage />
      </LivePage>
    </DocsHelpFetch>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: {
      apiRoutes: liveAppShellRoutes,
      enabledFlags: [
        LABS_NAV_SECTION_FEATURE_FLAG_KEY,
        HELP_COMPLETE_SURFACE_FLAG_KEY,
      ],
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expect(
      (await canvas.findAllByText(FIRST_PAGE?.title ?? "")).length
    ).toBeGreaterThan(0);
  },
};

/** The corpus index is still loading. */
export const Loading: Story = {
  parameters: { docsHelp: { nav: "pending" } },
};

/** The selected page is not in the corpus. */
export const NotFound: Story = {
  parameters: { docsHelp: { nav: "ok", page: "missing" } },
};

/** The corpus could not be read. */
export const Unavailable: Story = {
  parameters: { docsHelp: { nav: "failed" } },
};

/** This deployment ships no docs corpus. */
export const NotDeployed: Story = {
  parameters: { docsHelp: { nav: "not-deployed" } },
};

/** The selected page is still loading. */
export const PageLoading: Story = {
  parameters: { docsHelp: { nav: "ok", page: "pending" } },
};

/** The selected page's read failed. */
export const PageUnavailable: Story = {
  parameters: { docsHelp: { nav: "ok", page: "failed" } },
};

/** Another page chosen from the tree. */
export const OtherPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: SECOND_PAGE?.title })
    );
  },
};

async function search(canvasElement: HTMLElement) {
  const main = within(await within(canvasElement).findByRole("main"));
  await userEvent.type(await main.findByRole("searchbox"), "session");
}

/** A search with hits. */
export const SearchResults: Story = {
  play: async ({ canvasElement }) => search(canvasElement),
};

/** A search still running. */
export const SearchPending: Story = {
  parameters: { docsHelp: { nav: "ok", search: "pending" } },
  play: async ({ canvasElement }) => search(canvasElement),
};

/** A search with no hits. */
export const SearchNoResults: Story = {
  parameters: { docsHelp: { nav: "ok", search: [] } },
  play: async ({ canvasElement }) => search(canvasElement),
};

/** The search read failed. */
export const SearchUnavailable: Story = {
  parameters: { docsHelp: { nav: "ok", search: "failed" } },
  play: async ({ canvasElement }) => search(canvasElement),
};
