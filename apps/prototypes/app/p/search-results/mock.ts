// Presentational mock data for the Search Results prototype. No DB / API / auth.
// Result rows mirror the in-product SearchHit shape (entityType, title,
// snippet, updatedAt, a deep-link stand-in) closely enough to be a faithful
// design foundation.

import { EntityKind } from "./search-model";

// ---------------------------------------------------------------------------
// Sidebar navigation model (duplicated from the Web UI Kit; nothing "active" -
// /search has no nav entry, it is reached from the sidebar search box).
// ---------------------------------------------------------------------------

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  isActive?: boolean;
};

export type NavIconName =
  | "dashboard"
  | "inbox"
  | "my-issues"
  | "documents"
  | "issues"
  | "sessions"
  | "branches"
  | "agents"
  | "insights"
  | "loops"
  | "agent-monitoring"
  | "judges";

export type TeamItem = {
  id: string;
  name: string;
  isActive?: boolean;
};

export const primaryNav: readonly NavItem[] = [
  { label: "Dashboard", icon: "dashboard" },
  { label: "Inbox", icon: "inbox", count: 8 },
  { label: "My Issues", icon: "my-issues" },
];

export const artifactsNav: readonly NavItem[] = [
  { label: "Documents", icon: "documents" },
  { label: "Issues", icon: "issues" },
  { label: "Sessions", icon: "sessions" },
  { label: "Branches", icon: "branches" },
  { label: "Agents", icon: "agents" },
];

export const teams: readonly TeamItem[] = [
  { id: "team-demo", name: "ClosedLoop Demo" },
  { id: "team-closedloop", name: "ClosedLoop" },
  { id: "team-platform", name: "Platform Engineering" },
];

export const labsNav: readonly NavItem[] = [
  { label: "Insights", icon: "insights" },
  { label: "Loops", icon: "loops" },
  { label: "Agent Monitoring", icon: "agent-monitoring" },
  { label: "Judges", icon: "judges" },
];

// ---------------------------------------------------------------------------
// Result rows (mirrors SearchHit). `snippet` uses the same <b>…</b> match
// markers Postgres ts_headline emits, so the highlight renderer reads real.
// ---------------------------------------------------------------------------

export type ResultMeta = {
  /**
   * An optional prefix, kept ONLY where the bare value would be ambiguous
   * (`On FEA-4031`, `Team ClosedLoop`). Omitted where the value speaks for
   * itself (`Merged`, `Running`, `In review`) so the meta line reads like prose,
   * not a debug dump.
   */
  label?: string;
  value: string;
};

export type ResultHit = {
  id: string;
  kind: EntityKind;
  title: string;
  /** Highlighted excerpt with <b>…</b> match markers. */
  snippet: string;
  updated: string;
  meta: readonly ResultMeta[];
  /** True when the hit has no safe route (renders as a non-link row). */
  unlinked?: boolean;
};

// Several hits per type for the busiest kinds (Document, PullRequest, Session)
// so toggling the Type control visibly narrows a long list instead of leaving a
// single row — that is where the real row-rhythm/spacing calls get made.
export const mockResults: readonly ResultHit[] = [
  {
    id: "doc-1",
    kind: EntityKind.Document,
    title: "PRD 512 - Agent session collector hardening",
    snippet:
      "The collector must fold multi-turn <b>agent</b> transcripts into a single normalized session before the parser…",
    updated: "2 hours ago",
    meta: [{ value: "In review" }],
  },
  {
    id: "doc-2",
    kind: EntityKind.Document,
    title: "PLN 1495 - Search results redesign implementation plan",
    snippet:
      "Fold the kind-pill strip into the query grammar so an <b>agent</b> can compose type filters inline…",
    updated: "4 hours ago",
    meta: [{ value: "Approved" }],
  },
  {
    id: "doc-3",
    kind: EntityKind.Document,
    title: "FEA 4031 - JQL-look query bar",
    snippet:
      "A first-class editable query bar with filter tokens and a suggestion popover, driven by an <b>agent</b>…",
    updated: "6 hours ago",
    meta: [{ value: "In progress" }],
  },
  {
    id: "doc-4",
    kind: EntityKind.Document,
    title: "PRD 498 - Containerized e2e for the agent runner",
    snippet:
      "Run the Playwright suite against the <b>agent</b> stack inside docker-in-Dagger for shift-left parity…",
    updated: "1 day ago",
    meta: [{ value: "Draft" }],
  },
  {
    id: "pr-1",
    kind: EntityKind.PullRequest,
    title: "FEA-3877: VCS neutrality provider registry",
    snippet:
      "Introduces a provider registry so the <b>agent</b> runner resolves git vs. non-git backends at spawn time…",
    updated: "5 hours ago",
    meta: [{ value: "Merged" }],
  },
  {
    id: "pr-2",
    kind: EntityKind.PullRequest,
    title: "FEA-4031: search-results prototype",
    snippet:
      "Adds the presentational search redesign prototype the <b>agent</b> team reviews before the production build…",
    updated: "7 hours ago",
    meta: [{ value: "In review" }],
  },
  {
    id: "pr-3",
    kind: EntityKind.PullRequest,
    title: "FEA-3944: Fullscreen dashboard widgets fill height",
    snippet:
      "Dismiss frozen tooltips on expand and let the <b>agent</b> dashboard widgets fill the viewport height…",
    updated: "10 hours ago",
    meta: [{ value: "Merged" }],
  },
  {
    id: "session-1",
    kind: EntityKind.Session,
    title: "claude/night-crew · 2026-07-24 03:12",
    snippet:
      "Spawned <b>agent</b> to triage the desktop chunk-load regression; ran typecheck, patched the GPU overlay…",
    updated: "8 hours ago",
    meta: [{ value: "Completed" }],
  },
  {
    id: "session-2",
    kind: EntityKind.Session,
    title: "codex/produce · 2026-07-24 01:40",
    snippet:
      "Produce loop dispatched a ready FEAT to a codex <b>agent</b>; opened a green fix PR and moved it to review…",
    updated: "11 hours ago",
    meta: [{ value: "Completed" }],
  },
  {
    id: "session-3",
    kind: EntityKind.Session,
    title: "claude/design-review · 2026-07-23 22:05",
    snippet:
      "Parker <b>agent</b> ran a design pass on the search prototype and filed three token-drift findings…",
    updated: "1 day ago",
    meta: [{ value: "Failed" }],
  },
  {
    id: "branch-1",
    kind: EntityKind.Branch,
    title: "fix/desktop-chunk-load-and-gpu-overlay",
    snippet:
      "Branch off main carrying the <b>agent</b>-authored fix for the renderer chunk-load failure on cold start…",
    updated: "9 hours ago",
    meta: [{ value: "1 open PR" }],
  },
  {
    id: "comment-1",
    kind: EntityKind.Comment,
    title: "Comment on FEA-4031",
    snippet:
      "Parker: the kind-pill strip is horrible UX - fold it into the query model so the <b>agent</b> results read as one…",
    updated: "1 day ago",
    meta: [{ label: "On", value: "FEA-4031" }],
  },
  {
    id: "component-1",
    kind: EntityKind.Component,
    title: "night-crew-triage",
    snippet:
      "An <b>agent</b> component that sweeps the inbox each night, opens PRs for green fixes, and defers the rest…",
    updated: "1 day ago",
    meta: [{ label: "Agent", value: "Autonomous" }],
  },
  {
    id: "loop-1",
    kind: EntityKind.Loop,
    title: "produce · Mike's Workspace",
    snippet:
      "A produce loop that polls the queue and dispatches each ready FEAT to an <b>agent</b> worker…",
    updated: "2 days ago",
    meta: [{ value: "Running" }],
    unlinked: true,
  },
  {
    id: "project-1",
    kind: EntityKind.Project,
    title: "Mike's Workspace",
    snippet:
      "Workspace project holding the <b>agent</b> monitoring sprints and the search redesign track…",
    updated: "3 days ago",
    meta: [{ label: "Team", value: "ClosedLoop" }],
  },
];

/**
 * The total the "too many" state pretends the corpus has behind Load more. The
 * bar shows N of this total, so the count carries what the state is FOR (there
 * is more) instead of gluing a `+` onto a number the user can count.
 */
export const TOO_MANY_TOTAL = 1240;

// The example queries the empty-state on-ramp offers (a JQL cheat-sheet).
export type ExampleQuery = { query: string; caption: string };

export const exampleQueries: readonly ExampleQuery[] = [
  { query: "agent type:session status:DONE", caption: "Finished agent runs" },
  { query: "type:pull_request @me updated:7d", caption: "My recent PRs" },
  {
    query: "chunk-load type:branch type:document",
    caption: "Branches and docs, one query",
  },
  { query: "priority>=HIGH status:BLOCKED", caption: "Urgent and stuck" },
];

// ---------------------------------------------------------------------------
// Demo state switcher - lets a reviewer see all six states without a backend.
// ---------------------------------------------------------------------------

export const DemoState = {
  Results: "results",
  Empty: "empty",
  Loading: "loading",
  LoadError: "load-error",
  FilterError: "filter-error",
  NoResults: "no-results",
  TooMany: "too-many",
} as const;
export type DemoState = (typeof DemoState)[keyof typeof DemoState];

export type DemoStateMeta = {
  state: DemoState;
  label: string;
  /** The query the bar shows when this state is active. */
  query: string;
};

export const DEMO_STATES: readonly DemoStateMeta[] = [
  { state: DemoState.Results, label: "Results", query: "agent" },
  { state: DemoState.Empty, label: "Empty", query: "" },
  { state: DemoState.Loading, label: "Loading", query: "agent type:session" },
  {
    state: DemoState.LoadError,
    label: "Load error",
    query: "agent type:session",
  },
  {
    state: DemoState.FilterError,
    label: "Filter error",
    query: "agent status:huge",
  },
  {
    state: DemoState.NoResults,
    label: "No results",
    query: "quarterly-revenue-forecast type:branch",
  },
  { state: DemoState.TooMany, label: "Too many", query: "agent" },
];
