import {
  DocsHelpMatchField,
  type DocsHelpNavGroup,
  type DocsHelpPage,
  type DocsHelpSearchHit,
} from "@repo/app/help/lib/docs-help-payload";
import {
  DOCS_HELP_NAV_PATH,
  DOCS_HELP_PAGE_PATH,
  DOCS_HELP_SEARCH_PATH,
  DocsCorpusFailureReason,
} from "@repo/app/help/lib/web-help-contract";
import { type ReactNode, useEffect, useState } from "react";

// The live Help route (`apps/app/.../help/components/help-surface-host.tsx`)
// reads the docs corpus from the web app's own route handlers
// (`/api/docs-help`, `/page`, `/search`) with the browser's `fetch`, not the
// API client, so `appCore.apiRoutes` cannot answer them. `DocsHelpFetch`
// answers exactly those three paths, for the life of the story, and hands every
// other request to the real `fetch`.

export const docsNavFixture: readonly DocsHelpNavGroup[] = [
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
    pages: [
      { path: "concepts/artifacts", title: "Artifacts" },
      { path: "concepts/packs", title: "Packs" },
    ],
  },
  {
    group: "Integrations",
    pages: [
      { path: "integrations/github", title: "GitHub" },
      { path: "integrations/mcp", title: "MCP server" },
    ],
  },
];

const GETTING_STARTED_PAGE: DocsHelpPage = {
  body: "",
  description:
    "Connect your workspace, install the desktop client, and sync your first session.",
  group: "Getting Started",
  headings: [
    { level: 2, slug: "connect-github", text: "Connect GitHub" },
    {
      level: 2,
      slug: "install-the-desktop-client",
      text: "Install the desktop client",
    },
    {
      level: 2,
      slug: "sync-your-first-session",
      text: "Sync your first session",
    },
  ],
  path: "getting-started/index",
  renderBody: [
    "ClosedLoop records the sessions your agents run, links them to the branches and pull requests they produce, and measures what shipped.",
    "",
    "## Connect GitHub",
    "",
    "Install the ClosedLoop GitHub App on the organization that owns your repositories. Choose **Only select repositories** if you want to start small.",
    "",
    "## Install the desktop client",
    "",
    "1. Download the client for macOS or Windows.",
    "2. Sign in with the same account you use on the web.",
    "3. Pick the folders that hold your repositories.",
    "",
    "## Sync your first session",
    "",
    "Run any agent session in a connected repository. It appears under **Sessions** within a minute, with its transcript, cost and the branch it worked on.",
    "",
    "| Harness | Supported |",
    "| --- | --- |",
    "| Claude Code | Yes |",
    "| Codex | Yes |",
    "| OpenCode | Preview |",
  ].join("\n"),
  title: "Getting Started",
};

const PREREQUISITES_PAGE: DocsHelpPage = {
  body: "",
  description: "What you need installed before the first launch.",
  group: "Getting Started",
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
    "| Tool | Why |",
    "| --- | --- |",
    "| `gh` | Opening pull requests from the app |",
    "| `direnv` | Per-worktree environment files |",
  ].join("\n"),
  title: "Prerequisites",
};

const PAGES: Record<string, DocsHelpPage> = {
  [GETTING_STARTED_PAGE.path]: GETTING_STARTED_PAGE,
  [PREREQUISITES_PAGE.path]: PREREQUISITES_PAGE,
};

export const docsSearchHitsFixture: readonly DocsHelpSearchHit[] = [
  {
    excerpt:
      "Run any agent session in a connected repository. It appears under Sessions within a minute…",
    group: "Getting Started",
    headingSlug: "sync-your-first-session",
    matchField: DocsHelpMatchField.Heading,
    path: "getting-started/index",
    score: 0.92,
    title: "Getting Started",
  },
  {
    excerpt:
      "A session is one run of an agent harness, recorded with its transcript and cost…",
    group: "Concepts",
    matchField: DocsHelpMatchField.Body,
    path: "concepts/artifacts",
    score: 0.71,
    title: "Artifacts",
  },
];

export type DocsHelpCorpus = {
  /** `ok`: the corpus answers; `pending`: never settles; anything else fails. */
  nav: "ok" | "pending" | "not-deployed" | "failed";
  /** How the selected page's read goes. */
  page?: "ok" | "pending" | "missing" | "failed";
  /** Search hits, or `pending` / `failed`. */
  search?: readonly DocsHelpSearchHit[] | "pending" | "failed";
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const NEVER = () => new Promise<Response>(() => undefined);

function answer(corpus: DocsHelpCorpus, url: URL): Promise<Response> | null {
  if (url.pathname === DOCS_HELP_NAV_PATH) {
    switch (corpus.nav) {
      case "ok":
        return Promise.resolve(json({ navGroups: docsNavFixture }));
      case "pending":
        return NEVER();
      case "not-deployed":
        return Promise.resolve(
          json({ reason: DocsCorpusFailureReason.NotDeployed }, 503)
        );
      default:
        return Promise.resolve(
          json({ reason: DocsCorpusFailureReason.ReadFailed }, 500)
        );
    }
  }
  if (url.pathname === DOCS_HELP_PAGE_PATH) {
    const page = PAGES[url.searchParams.get("path") ?? ""];
    switch (corpus.page ?? "ok") {
      case "pending":
        return NEVER();
      case "failed":
        return Promise.resolve(json({}, 500));
      case "missing":
        return Promise.resolve(json({}, 404));
      default:
        return Promise.resolve(page ? json({ page }) : json({}, 404));
    }
  }
  if (url.pathname === DOCS_HELP_SEARCH_PATH) {
    const search = corpus.search ?? docsSearchHitsFixture;
    if (search === "pending") {
      return NEVER();
    }
    if (search === "failed") {
      return Promise.resolve(json({}, 500));
    }
    return Promise.resolve(json({ hits: search }));
  }
  return null;
}

/** Answers the Help route's docs reads from `corpus` while mounted. */
export function DocsHelpFetch({
  children,
  corpus,
}: {
  children: ReactNode;
  corpus: DocsHelpCorpus;
}) {
  // Installed during the first render, before any query effect can fetch.
  const [original] = useState(() => {
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      const url = new URL(raw, globalThis.location?.href ?? "http://localhost");
      return answer(corpus, url) ?? real(input, init);
    };
    return real;
  });
  useEffect(
    () => () => {
      globalThis.fetch = original;
    },
    [original]
  );
  return children;
}
