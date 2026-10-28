import type { Meta, StoryObj } from "@storybook/react";
import type { DocsHelpNavGroup, DocsHelpPage } from "../lib/docs-help-payload";
import {
  DocsHelpBundleStatus,
  type DocsHelpSource,
} from "../lib/docs-help-source";
import { HelpSurfaceV2 } from "./help-surface-v2";

const SLUG_STRIP_RE = /[^a-z0-9\s-]/g;
const SLUG_SPACE_RE = /\s+/g;

/** Stands in for the host's generator-bound slug; see the prop's docstring. */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(SLUG_STRIP_RE, "")
    .trim()
    .replace(SLUG_SPACE_RE, "-");
}

const NAV_GROUPS: readonly DocsHelpNavGroup[] = [
  {
    group: "Getting Started",
    pages: [
      { path: "getting-started/index", title: "Getting Started" },
      { path: "getting-started/prerequisites", title: "Prerequisites" },
      {
        path: "getting-started/install-desktop",
        title: "Install the desktop client",
      },
    ],
  },
  {
    group: "Concepts",
    pages: [{ path: "concepts/artifacts", title: "Artifacts" }],
  },
];

const PREREQUISITES_PAGE: DocsHelpPage = {
  body: "",
  description: "What you need installed before the first launch.",
  headings: [
    { level: 2, slug: "required-tools", text: "Required tools" },
    { level: 2, slug: "optional-tools", text: "Optional tools" },
  ],
  path: "getting-started/prerequisites",
  renderBody: [
    "## Required tools",
    "",
    "- Node.js 22 or newer",
    "- `git`, on your `PATH`",
    "",
    "## Optional tools",
    "",
    "Install these when you need them, not before.",
    "",
    "| Tool | Why |",
    "| --- | --- |",
    "| `gh` | Opening pull requests from the app |",
    "| `direnv` | Per-worktree environment files |",
  ].join("\n"),
  title: "Prerequisites",
};

function source(overrides: Partial<DocsHelpSource> = {}): DocsHelpSource {
  return {
    bundleStatus: DocsHelpBundleStatus.Ready,
    docsSiteUrl: "https://closedloop.ai/docs",
    isSearching: false,
    navGroups: NAV_GROUPS,
    onHeadingHandled: () => undefined,
    onSearchQueryChange: () => undefined,
    page: { kind: "found", page: PREREQUISITES_PAGE },
    pendingHeadingSlug: null,
    searchFailed: false,
    searchHits: [],
    searchQuery: "",
    selectPage: () => undefined,
    selectedPath: PREREQUISITES_PAGE.path,
    ...overrides,
  };
}

/**
 * ISS-10006 — the corpus sentences are host-supplied now, so the stories pick a
 * host to be. Desktop's, because these stories were drawn for the packed
 * snapshot and every degraded state below reads against that wording.
 */
const STORY_CORPUS_COPY = {
  corpusUnavailableDetail:
    "The bundled documentation snapshot isn't available in this build.",
  corpusUnavailableTitle: "Docs aren't available offline",
  navEmptyDetail: "No documentation sections are listed in this build.",
  pageMissingDetail:
    "This page isn't in the bundled docs snapshot. It may be newer than your app.",
};

function render(overrides: Partial<DocsHelpSource> = {}) {
  return (
    <div className="h-[38rem]">
      <HelpSurfaceV2
        corpusCopy={STORY_CORPUS_COPY}
        slugifyHeading={slugifyHeading}
        source={source(overrides)}
      />
    </div>
  );
}

/**
 * ISS-10005: one story per state of the Help ladder.
 *
 * Four of them look alike in a DOM assertion and nothing alike to a reader — a
 * bundle still loading, a bundle this build does not carry, a page the snapshot
 * has never heard of, and a page it holds but cannot render. Conflating any two
 * is how a Help screen starts telling a reader to go looking for something that
 * is right in front of them.
 *
 * ISS-10044 adds the two that are not claims about the docs at all: a page read
 * and a search that never came back.
 */
const meta = {
  args: { corpusCopy: STORY_CORPUS_COPY, slugifyHeading, source: source() },
  component: HelpSurfaceV2,
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Help/Help Surface V2",
} satisfies Meta<typeof HelpSurfaceV2>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Ready: Story = { render: () => render() };

export const Loading: Story = {
  render: () =>
    render({
      bundleStatus: DocsHelpBundleStatus.Loading,
      page: { kind: "loading" },
    }),
};

/** No snapshot in this build — the only remaining route to the docs is online. */
export const BundleUnavailable: Story = {
  render: () =>
    render({ bundleStatus: DocsHelpBundleStatus.Unavailable, navGroups: [] }),
};

export const PageLoading: Story = {
  render: () => render({ page: { kind: "loading" } }),
};

/** The snapshot has never heard of this page — likely newer than the app. */
export const PageNotFound: Story = {
  render: () => render({ page: { kind: "missing" } }),
};

/**
 * ISS-10044. The page request REJECTED, so nothing was read that could support
 * {@link PageNotFound}'s sentence about the snapshot's contents. Beside it on
 * purpose: these two are the pair the defect collapsed.
 */
export const PageUnavailable: Story = {
  render: () => render({ page: { kind: "error" } }),
};

/**
 * The snapshot HOLDS this page and handed over something unrenderable. Beside
 * {@link PageNotFound} on purpose: the two must not read the same, or a reader
 * goes looking for a page that is right there.
 */
export const PageMalformed: Story = {
  render: () =>
    render({
      page: {
        kind: "found",
        page: {
          ...PREREQUISITES_PAGE,
          body: undefined,
        } as unknown as DocsHelpPage,
      },
    }),
};

/**
 * One group arrived unreadable. The tree keeps the rest AND says a section is
 * missing — without that line this story is pixel-identical to {@link Ready},
 * and so is the screen a reader sees when a page they know exists is gone.
 */
export const UnreadableNavGroup: Story = {
  render: () =>
    render({
      navGroups: [
        { group: "Reference" },
        ...NAV_GROUPS,
      ] as unknown as readonly DocsHelpNavGroup[],
    }),
};

/** Every group refused: a tree that cannot be browsed still offers a way out. */
export const NavIndexUnreadable: Story = {
  render: () =>
    render({
      navGroups: [
        { group: "Reference" },
      ] as unknown as readonly DocsHelpNavGroup[],
    }),
};

export const SearchResults: Story = {
  render: () =>
    render({
      searchHits: [
        {
          excerpt: "Install these when you need them, not before.",
          headingSlug: "optional-tools",
          matchField: "heading",
          path: "getting-started/prerequisites",
          score: 12,
          title: "Prerequisites",
        },
      ],
      searchQuery: "tools",
    }),
};

export const SearchPending: Story = {
  render: () => render({ isSearching: true, searchQuery: "tools" }),
};

export const SearchNoResults: Story = {
  render: () => render({ searchQuery: "kubernetes" }),
};

/**
 * ISS-10044. The search REJECTED. Beside {@link SearchNoResults} on purpose:
 * both are zero rows, and only the copy separates "nothing matched" from
 * "nothing was searched".
 */
export const SearchUnavailable: Story = {
  render: () => render({ searchFailed: true, searchQuery: "kubernetes" }),
};

/**
 * The nav pane is a fixed `w-72`, so at phone width it takes most of the
 * viewport and the reader gets what is left. Pinned in a story because that is
 * crowding geometry, which no DOM assertion sees.
 */
export const NarrowWidth: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => render(),
};
