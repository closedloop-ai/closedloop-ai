import {
  type CompleteSurfaceEntry,
  SurfaceMastery,
} from "./complete-surface-registry";
import { ShellNavigationSurface } from "./shell-navigation-contract";

/**
 * ISS-9395 — the authenticated contextual route families, classified on the
 * same terms as the shell routes.
 *
 * The shell contract names 22 route identities and stops there, so every detail,
 * drilldown and workflow route in the product sat outside every parity map the
 * repository had. That is a bigger blind spot than it sounds: only THREE of
 * these families are reachable on both hosts at all, and the desktop route table
 * silently drops any href it does not match (`handleUnmappedHref`), so a
 * contextual route missing from Desktop fails by going nowhere rather than by
 * erroring.
 *
 * MEMBERSHIP IS PRD-730's, NOT THIS MODULE's. The parent PRD's scope inventory
 * names exactly what is in: "Session, Branch and Agent details; artifact details
 * for PRD, Implementation Plan, Issue and Document; Search; Loops; and
 * project/team/user contextual routes." Those are here, classified, except
 * Loops, which PRD-795 (ISS-12435) removed; eleven remain.
 *
 * Two MORE contextual routes exist in `apps/app` that the PRD's scope
 * inventory neither includes nor excludes. They are carried here as
 * {@link SurfaceMastery.Undecided} rather than quietly dropped or quietly
 * excluded: a route nobody has ruled on is a question for a human, and guessing
 * either way is how a capability leaves a program's scope without anyone
 * choosing that. They are NOT counted toward the in-scope totals.
 *
 * Deliberately absent, because PRD-730's exclusion list already names them:
 * guided onboarding and the global shell (PRD-692), Engineer/build routes
 * slated for removal (`build/[id]`), OAuth callback and authorization routes
 * (the desktop pairing `authorize`/`connect` pages), internal RUM validation
 * (`rum-validation`), and redirects plus admin compatibility entries that are
 * not final product surfaces (`admin/catalog`, the `loops` list and
 * `loops/monitoring` redirects, the non-org legacy `sessions` routes, and the
 * `[orgSlug]` root redirect).
 */

/**
 * The four artifact subtypes are absent from Desktop for one reason, stated
 * once. Declared above the registry rather than at the bottom of the file
 * because the object literal below reads it at module evaluation.
 */
const DESKTOP_HOSTS_NO_DOCUMENT_ROUTES =
  "Desktop hosts no document detail routes at all: route-table.ts defines only /sessions/:id, /branches/:id and /agents/:id, so an artifact href is dropped by handleUnmappedHref. The desktop's answer is an explicit escape hatch rather than a gap it fell into — apps/desktop/src/renderer/shared-agent-sessions/artifact-web-href.ts builds an absolute https:// web-app URL and hands it to the OS browser through Electron's window-open handler. The BODY is already shared: all four web routes are thin per-subtype composition around DocumentEditorScaffold, so what Desktop lacks is a route and a transport, not a component. PRD-730 assigns ISS-9411 (wave-fs-4-contextual) to master artifact detail and editor surfaces across document subtypes.";

export const ContextualRouteFamilyId = {
  SessionDetail: "session-detail",
  BranchDetail: "branch-detail",
  AgentDetail: "agent-detail",
  PrdDetail: "prd-detail",
  ImplementationPlanDetail: "implementation-plan-detail",
  IssueDetail: "issue-detail",
  DocumentDetail: "document-detail",
  Search: "search",
  ProjectContext: "project-context",
  TeamContext: "team-context",
  UserContext: "user-context",
  JudgesMetricDetail: "judges-metric-detail",
  InShellNotFound: "in-shell-not-found",
} as const;
export type ContextualRouteFamilyId =
  (typeof ContextualRouteFamilyId)[keyof typeof ContextualRouteFamilyId];

/**
 * Exhaustive over {@link ContextualRouteFamilyId}. A family added to the const
 * and not to this map fails `tsc`, exactly as the shell registry does — the
 * contextual half of the program cannot silently acquire an unclassified route.
 */
export const CONTEXTUAL_SURFACE_REGISTRY = {
  /**
   * PRD-730's baseline calls these three "already shared, cataloged masters
   * [that] need no duplicate implementation issue". That sentence is a SCOPE
   * statement — it says no new wave-fs issue is filed for them — and this
   * registry originally read it as an evidence statement and classified all
   * three `Mastered`. Whitlockk's review of #6741 checked the hosts instead, and on
   * every one of the three the two hosts observably differ in what the user can
   * see and do, outside the five host boundary seams the contract allows. So
   * each is `Partial` with the divergence named: a shared BODY is real and is what
   * the PRD is describing, but "one export is the whole feature body on both
   * hosts" is a stronger claim than the code supports today.
   *
   * Closing each gap means moving a host-composed control or section into the
   * shared owner, which is wave-fs work rather than this wave-0 contract
   * ticket — the same line every other `Partial` entry here sits on.
   */
  [ContextualRouteFamilyId.SessionDetail]: {
    mastery: SurfaceMastery.Partial,
    owner: {
      module:
        "packages/app/agents/components/detail/agent-session-detail-view.tsx",
      exportName: "AgentSessionDetailView",
    },
    webHost: "apps/app/app/(authenticated)/[orgSlug]/sessions/[id]/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/sessions/SessionDetailView.tsx",
    gap: "Both hosts mount AgentSessionDetailView, but the web host also composes the surface's own toolbar beside it: SessionDetailActions renders the comments-rail toggle into the route Header, and the host owns the `commentsRailOpen` state it passes back down. Desktop renders no such control and passes no `commentsRailOpen` at all, so the two hosts disagree on a control the contract makes surface-owned (SurfaceOwnedConcern.Toolbar). Mastering it means the surface owning that control; that is wave-fs work, not this wave. ISS-12269 removed the Refresh button and the overflow kebab this gap also used to name.",
  },
  [ContextualRouteFamilyId.BranchDetail]: {
    mastery: SurfaceMastery.Partial,
    owner: {
      module: "packages/app/branches/components/branch-detail-page.tsx",
      exportName: "BranchDetailPage",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/branches/[branchId]/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/branches/branch-detail-view.tsx",
    gap: "The desktop host picks a state the surface never sees: when the branches source is local and the route id is a cloud artifact UUID it returns BranchDetailWorkspaceOnlyState and BranchDetailPage is never mounted (branch-detail-view.tsx `branchIsWorkspaceOnly`). State selection is surface-owned (SurfaceOwnedConcern.StateSelection), so that alone stops this being mastered. The two hosts also compose different visible structure around the body — web injects a `relatedSessionsSlot` (RelatedSessionsSection, a web-only PostHog key) and a GitHubConnectReturnNotice, desktop stacks its connect-status and cloud-hydration banners. ISS-9415-era work, not this wave.",
  },
  [ContextualRouteFamilyId.AgentDetail]: {
    mastery: SurfaceMastery.Partial,
    owner: {
      module: "packages/app/agents/components/workspace/agent-detail.tsx",
      exportName: "AgentDetail",
    },
    webHost: "apps/app/app/(authenticated)/[orgSlug]/agents/[slug]/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/agents/agent-detail-view.tsx",
    gap: "Neither host mounts one complete body. Web (via agent-detail-with-promote.tsx, which the registered route file renders) fills AgentDetail's `analytics` slot with its own TokenTrendSection — a heading, prose and a chart — and its `headerAction` with the Clerk-admin-gated Promote. Desktop passes NO `analytics` slot and instead APPENDS OptimizationAnalyticsPanel as a sibling below AgentDetail, with an Install-only header action. Those are visible sections and controls the contract assigns to the surface (SurfaceOwnedConcern.Hierarchy and Toolbar), not to a host seam. The registered webHost is also one indirection above the mount — the route file renders agent-detail-with-promote.tsx, which is what actually imports AgentDetail — so mastering this family has to settle which file is the host as well as what it may compose.",
  },
  /**
   * The four artifact subtypes are four sibling web routes over ONE shared
   * scaffold, prefixed per DocumentType. Each is registered separately because
   * each has its own host composition around that scaffold, so "the artifact
   * editor is mastered" would be four different claims collapsed into one.
   */
  [ContextualRouteFamilyId.PrdDetail]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: {
      module: "packages/app/documents/components/document-editor-scaffold.tsx",
      exportName: "DocumentEditorScaffold",
    },
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/documents/[slug]/page.tsx",
    missingCapability: DESKTOP_HOSTS_NO_DOCUMENT_ROUTES,
  },
  [ContextualRouteFamilyId.ImplementationPlanDetail]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: {
      module: "packages/app/documents/components/document-editor-scaffold.tsx",
      exportName: "DocumentEditorScaffold",
    },
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/documents/[slug]/page.tsx",
    missingCapability: DESKTOP_HOSTS_NO_DOCUMENT_ROUTES,
  },
  [ContextualRouteFamilyId.IssueDetail]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: {
      module: "packages/app/documents/components/document-editor-scaffold.tsx",
      exportName: "DocumentEditorScaffold",
    },
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/documents/[slug]/page.tsx",
    missingCapability: DESKTOP_HOSTS_NO_DOCUMENT_ROUTES,
  },
  [ContextualRouteFamilyId.DocumentDetail]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: {
      module: "packages/app/documents/components/document-editor-scaffold.tsx",
      exportName: "DocumentEditorScaffold",
    },
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/documents/[slug]/page.tsx",
    missingCapability: DESKTOP_HOSTS_NO_DOCUMENT_ROUTES,
  },
  /**
   * ISS-9414 built `SearchSurfaceV2` and gave BOTH hosts a mount of it: the web
   * `/search` route in page mode, the desktop ⌘K palette in overlay mode, each
   * reading `portable-search-surface` once at its own mount site.
   *
   * PARTIAL, NOT MASTERED, and the `gap` says why in the registry's own terms:
   * both hosts still compose visible structure BESIDE the surface, the desktop
   * reach is a palette rather than a route, and the mount is behind a key that
   * does not exist in PostHog yet.
   */
  [ContextualRouteFamilyId.Search]: {
    mastery: SurfaceMastery.Partial,
    owner: {
      module: "packages/app/search/components/search-surface-v2.tsx",
      exportName: "SearchSurfaceV2",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/search/components/search-results.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/command-palette/docs-search-surface-group.tsx",
    gap: "NOT YET REACHED BY ANY USER: `portable-search-surface` is default-off and has not been created in PostHog (scripts/lint/posthog-flag-registration-ledger.ts records it Unverified), so today BOTH hosts still render their pre-ISS-9414 fork — UnifiedSearchResults on web, DocsCommandGroup in the desktop palette — and the `webHost`/`desktopHost` paths above are the flag-ON mounts, not what ships. On the flag-ON path the surface owns the results but the QUERY ENTRY around it is still each host's: web composes SearchTypeahead, the mouse-first SearchTypeControl and the result-count strip beside it; Desktop composes the CommandDialog and its CommandInput, and reaches the surface only through the ⌘K palette because route-table.ts still defines no /search route, so a /search href is dropped there as before. The two hosts also still search DIFFERENT corpora behind identical rows: the org FTS index on web, the local docs index over IPC on desktop. Mastering the entry and reconciling the corpora are not ISS-9414's; retiring the legacy forks is ISS-9415 (wave-fs-5-validation).",
  },
  [ContextualRouteFamilyId.ProjectContext]: {
    mastery: SurfaceMastery.Partial,
    owner: {
      module: "packages/app/projects/components/project-detail-page.tsx",
      exportName: "ProjectDetailPage",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/projects/project-context-view.tsx",
    gap: "Both hosts mount the shared project detail body behind projects-portable-surface. The web adapter retains its route Header and the legacy detail body when that flag is off. Desktop's new project destinations are unavailable when it is off.",
  },
  [ContextualRouteFamilyId.TeamContext]: {
    mastery: SurfaceMastery.Partial,
    owner: {
      module: "packages/app/projects/components/projects-portable-surface.tsx",
      exportName: "ProjectsPortableSurface",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/projects/project-context-view.tsx",
    gap: "Teams remain sidebar contexts whose destinations are team-scoped project lists. Both shells mount ProjectsPortableSurface behind projects-portable-surface; web retains its existing flag-off list and Desktop gates its new team/project destinations. Team dialogs and sidebar data are shared, while the shell owns sidebar placement and its preexisting Labs availability.",
  },
  [ContextualRouteFamilyId.UserContext]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: null,
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/users/[userId]/page.tsx",
    missingCapability:
      "Desktop has no user routes — desktop-adapter.tsx names /users/:id as its canonical example of an href the route table does not map and the nav guard drops. The 533-line web page owns the body; packages/app/users exports sections and hooks but no page owner. PRD-730 assigns ISS-9412.",
  },
  /**
   * The two routes PRD-730's scope inventory neither includes nor excludes.
   * Each states what a human must rule on. None is counted in the in-scope
   * totals, and none is guessed at.
   */
  [ContextualRouteFamilyId.JudgesMetricDetail]: {
    mastery: SurfaceMastery.Undecided,
    escalation:
      "apps/app/app/(authenticated)/[orgSlug]/judges-analytics/[metricName]/page.tsx (166 lines) is a real, reachable drilldown off the Judges route, but PRD-730's scope inventory names neither it nor judge drilldowns generally — its included list stops at 'project/team/user contextual routes'. Judges itself IS in scope via ISS-9407. Needs an owner decision: does ISS-9407 carry this drilldown, or is it out of the program? Classifying it excluded on the strength of the parent issue's silence would drop a reachable surface nobody ruled on.",
  },
  [ContextualRouteFamilyId.InShellNotFound]: {
    mastery: SurfaceMastery.Undecided,
    escalation:
      "apps/app/app/(authenticated)/[orgSlug]/[...unmatched]/page.tsx renders an in-shell 404 via notFound(). It is user-reachable and renders inside the shell, so it is not obviously covered by PRD-730's exclusion of 'redirects and admin compatibility entries that are not final product surfaces' — a 404 is neither a redirect nor an admin entry. Needs a one-line owner ruling: is an error/not-found body a product surface this program masters, or out of scope on every host?",
  },
} as const satisfies Record<ContextualRouteFamilyId, CompleteSurfaceEntry>;

/** Every classified contextual family id, in declaration order. */
export const CONTEXTUAL_ROUTE_FAMILY_IDS: readonly ContextualRouteFamilyId[] =
  Object.keys(CONTEXTUAL_SURFACE_REGISTRY) as ContextualRouteFamilyId[];

/**
 * The families carried for visibility but NOT in PRD-730's scope inventory, so
 * NOT counted in the program totals. Derived from the registry so the two can
 * never disagree.
 */
export function undecidedContextualFamilies(): readonly ContextualRouteFamilyId[] {
  return CONTEXTUAL_ROUTE_FAMILY_IDS.filter(
    (id) => CONTEXTUAL_SURFACE_REGISTRY[id].mastery === SurfaceMastery.Undecided
  );
}
