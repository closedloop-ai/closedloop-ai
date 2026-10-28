import { DiagnosticsSectionId } from "@repo/app/diagnostics/lib/diagnostics-sections";
import type {
  DocsHelpNavGroup,
  DocsHelpPage,
} from "@repo/app/help/lib/docs-help-payload";

/**
 * The route-level notice a Web host renders in place of a probe result. Web
 * having no probe is a fact about the host, not one of the treatments the
 * 2026-09-22 ruling chose between, so it is stated the same way regardless of
 * how any individual section is handled.
 */
export const WEB_PROBE_UNAVAILABLE_MESSAGE =
  "Diagnostics are collected by the desktop app on the machine that runs your agents. This browser has no record of them.";

/**
 * The three host-supplied values the surfaces' contracts gained with the
 * production mount (PR #7757): the page description, the per-section
 * unservable reason, and Help's corpus copy. Fixtures of the same sentences the
 * production web host passes, because the sandbox can import neither
 * `apps/app` nor `apps/desktop`.
 */
export const WEB_DIAGNOSTICS_DESCRIPTION =
  "What the desktop app collects about the machine that runs your agents.";

export const WEB_SECTION_UNSERVABLE_REASON =
  "Only the desktop app on that machine has it.";

export const WEB_DOCS_CORPUS_COPY = {
  corpusUnavailableDetail: "We couldn't load the documentation just now.",
  corpusUnavailableTitle: "Docs aren't available right now",
  navEmptyDetail: "No documentation sections came back with this response.",
  pageMissingDetail: "This page isn't in the documentation we're serving.",
} as const;

/**
 * Mirrors the desktop contract's ACTIVITY_COVERAGE_AXIS_LABELS: the keys are the
 * metric module's CohortAxis values, so they are corpus vocabulary rather than
 * device data and a Web host would carry the same map.
 */
export const COVERAGE_AXIS_LABELS: Readonly<Record<string, string>> = {
  harness: "Harness",
  autonomy_band: "Autonomy",
  closedloop_user: "ClosedLoop user",
  length_band: "Session length",
};

export const DIAGNOSTICS_ROUTE_TITLE = "Diagnostics";

/** Groups from each meta.json's title; page titles from the .mdx frontmatter. */
export const DOCS_NAV_GROUPS: readonly DocsHelpNavGroup[] = [
  {
    group: "Mechanisms",
    pages: [
      { path: "mechanisms/loops", title: "Loops", group: "Mechanisms" },
      { path: "mechanisms/sessions", title: "Sessions", group: "Mechanisms" },
      {
        path: "mechanisms/recovery",
        title: "Recovery and Resilience",
        group: "Mechanisms",
      },
    ],
  },
  {
    group: "Teams & Collaboration",
    pages: [
      {
        path: "collaboration/search",
        title: "Search & Discovery",
        group: "Teams & Collaboration",
      },
    ],
  },
];

/**
 * Titles, descriptions and opening bodies verbatim from the .mdx frontmatter and
 * first paragraph; `headings` are the real `##` headings. Loops carries the full
 * set so a search hit can deep-link to one and the reader pane really scrolls,
 * which is the capability the matrix claims Web can execute.
 */
export const DOCS_PAGES: readonly DocsHelpPage[] = [
  {
    path: "mechanisms/loops",
    title: "Loops",
    description:
      "Execution runs that take a scoped artifact, run through gated phases, and return reviewable output.",
    group: "Mechanisms",
    headings: [
      { level: 2, text: "Lifecycle", slug: "lifecycle" },
      { level: 2, text: "Bounded retries", slug: "bounded-retries" },
      { level: 2, text: "Outputs", slug: "outputs" },
    ],
    body: "The orchestrator prompt at plugins/code/prompts/prompt.md drives the phased workflow; state persists entirely in files under the work directory.",
    renderBody:
      "## Lifecycle\n\nThe orchestrator prompt at `plugins/code/prompts/prompt.md` drives the phased workflow; state persists entirely in files under the work directory.\n\n## Bounded retries\n\n## Outputs",
  },
  {
    path: "mechanisms/sessions",
    title: "Sessions",
    description:
      "The Sessions surface — the list, detail, and trace of every AI coding run Closedloop.ai observes, plus the filters, status model, cost buckets, and PR/branch attribution behind it.",
    group: "Mechanisms",
    headings: [
      { level: 2, text: "The list", slug: "the-list" },
      { level: 2, text: "Filters", slug: "filters" },
      { level: 2, text: "The status model", slug: "the-status-model" },
    ],
    body: "A session is a single AI coding run — one Claude, Codex, Cursor, Copilot, or OpenCode invocation — that the desktop client observed, normalized, and (when signed in) synced to the cloud.",
    renderBody:
      "A **session** is a single AI coding run — one Claude, Codex, Cursor, Copilot, or OpenCode invocation — that the desktop client observed, normalized, and (when signed in) synced to the cloud.\n\n## The list\n\n## Filters\n\n## The status model",
  },
  {
    path: "mechanisms/recovery",
    title: "Recovery and Resilience",
    description:
      "How Closedloop survives crashes, restarts, and ghost loops without losing progress.",
    group: "Mechanisms",
    headings: [{ level: 2, text: "Graceful quit", slug: "graceful-quit" }],
    body: "Loops are long-running, and long-running work eventually collides with an app restart, a CMD+Q, a hung process, or a transient network blip. Closedloop's recovery layer is designed so the state you see in the web app always matches what happened on disk.",
    renderBody:
      "Loops are long-running, and long-running work eventually collides with an app restart, a CMD+Q, a hung process, or a transient network blip.\n\n## Graceful quit",
  },
  {
    path: "collaboration/search",
    title: "Search & Discovery",
    description: "Find projects and documents across your organization",
    group: "Teams & Collaboration",
    headings: [
      { level: 2, text: "Free-text search", slug: "free-text-search" },
      { level: 2, text: "Search by tag", slug: "search-by-tag" },
      { level: 2, text: "Search via MCP", slug: "search-via-mcp" },
    ],
    body: "Closedloop provides a global, free-text search across your organization's projects and artifacts, plus tag-scoped discovery.",
    renderBody:
      "Closedloop provides a global, free-text search across your organization's projects and artifacts, plus tag-scoped discovery.\n\n## Free-text search\n\n## Search by tag\n\n## Search via MCP",
  },
];

/** The live docs site the bundle stamps in; web serves the same pages from it. */
export const DOCS_SITE_URL = "https://closedloop.ai/docs";

/** The page the Help preview opens on, so the reader pane is not blank. */
export const DEFAULT_DOCS_PATH = "mechanisms/loops";

/**
 * The optional sections a Web host offers, per the 2026-09-22 treatment ruling:
 * Withheld and Coverage keep their tabs. Dropping them from this list would
 * shorten the tab strip with no statement, which is the SILENT omission the
 * ruling rejected — `DIAGNOSTICS_SECTIONS` already says an always-on section
 * "owes the reader that section's own unavailable render, not a silently
 * shorter tab strip", and the ruling extends that to the optional pair.
 *
 * Gateway Logs is absent here because its tab is offered iff the host supplies
 * a `logs` node, which this sandbox has nothing device-local to put in.
 */
export const WEB_AVAILABLE_SECTIONS: readonly DiagnosticsSectionId[] = [
  DiagnosticsSectionId.Withheld,
  DiagnosticsSectionId.Coverage,
];
