import type { SurfaceOwnedConcern as SurfaceOwnedConcernType } from "./complete-surface-contract";
import {
  ShellNavigationRouteId,
  ShellNavigationSurface,
} from "./shell-navigation-contract";

/**
 * ISS-9395 — which component owns the complete surface behind every durable
 * shell route, and where each route actually stands.
 *
 * The repository had no such statement. `SessionsListSurfaceV2` and
 * `BranchesListSurfaceV2` were the only named complete list composites, and
 * `GridTableListSurface` sat underneath them as a generic primitive any host
 * could reach for — so "is this route mastered?" was answerable only by reading
 * the host. Twenty implementation issues under PRD-730 depend on that answer.
 *
 * WHY THIS IS NOT A LEDGER OF PROPS. ISS-8636 built a host↔surface capability
 * ledger, and ISS-9218 then found it could stay green through visible
 * divergence: `pageSizeOptions` was supplied on web, `notSupported` on desktop,
 * and the reason was `"See onPageSizeChange."`. ISS-9218 closed that for
 * PRESENTATION props specifically. It did not, and could not, make a green
 * ledger mean a mastered route — a ledger only ever describes the props of ONE
 * component, so a route whose two hosts mount two DIFFERENT components has two
 * green ledgers and no parity at all.
 *
 * So mastery here is decided on evidence a ledger cannot produce: the OWNER and
 * the two HOST PATHS. {@link SurfaceMastery.Mastered} claims one named export in
 * `packages/app` is the whole feature body on both hosts, and the source guard
 * reads the hosts' imports to check it. `notSupported` is not consulted, cannot
 * raise a classification, and a host may honestly withhold a host-capability
 * prop on a route that is nonetheless mastered — because mastery is about who
 * COMPOSES the body, not about which optional props are wired.
 *
 * The reachability half is likewise checked, not asserted: every
 * {@link SurfaceMastery.SingleHost} entry names the host it is present on, and
 * `apps/desktop/src/renderer/navigation/__tests__/complete-surface-registry-reachability.test.ts`
 * reads that back against `WEB_SHELL_ROUTE_HREFS` and
 * `DESKTOP_SHELL_ROUTE_NAV_IDS`, the two production maps the shells actually
 * navigate by. A route that gains a second host adapter reddens here rather
 * than sitting misclassified.
 */

export const SurfaceMastery = {
  /**
   * One named `packages/app` export is the entire feature body on BOTH hosts.
   * The hosts supply only {@link HostBoundarySeam} values.
   */
  Mastered: "mastered",
  /**
   * Reachable on both hosts, but at least one of them still composes visible
   * structure or picks a state itself. `gap` says what stops it being mastered.
   */
  Partial: "partial",
  /**
   * Reachable on exactly one host. `missingCapability` states what the absent
   * host lacks — a fact about the code, not a guess at intent.
   *
   * READ THE FIELD FOR WHAT IT IS. An audit of all thirteen single-host shell
   * routes found NO documented rationale for ANY of them: both reachability
   * maps landed in one commit (ISS-8354) that says it transcribed each shell's
   * existing navigation "without changing current rendered navigation
   * behavior", and both map docstrings restate the null ("does not currently
   * expose", "has no first-class Desktop nav id today") rather than justify it.
   * No comment, ticket, runbook or AGENTS.md rule anywhere says why any of the
   * thirteen is single-host.
   *
   * So `missingCapability` deliberately records only two things: the observable
   * code fact of what the absent host has (usually nothing), and the PRD-730
   * issue that owns closing it. Where a host coupling IS observable — a
   * `window.desktopApi.*` call, a native picker, a dependency the other host
   * does not ship — it is named as EVIDENCE. It is never presented as the
   * reason someone chose this, because nobody recorded choosing it. Four of the
   * web-only routes (Judges, Documents, My Tasks, Issues) have no host coupling
   * at all and are portable as written; their entries say nothing more than
   * that the desktop map is null.
   */
  SingleHost: "single-host",
  /**
   * A documented decision that this route needs no complete surface.
   * `decision` MUST cite where that decision is recorded. This value is never
   * correct as a default: absence of a host is {@link SingleHost}, and absence
   * of a decision is {@link Undecided}.
   */
  IntentionallyExcluded: "intentionally-excluded",
  /**
   * No documented decision exists either way. `escalation` says what must be
   * answered and by whom.
   *
   * This member exists so the registry can be exhaustive WITHOUT inventing
   * intent. Classifying an unexamined route as
   * {@link IntentionallyExcluded} is how a capability quietly leaves a
   * program's scope, so the type makes "nobody has decided" a first-class,
   * greppable answer rather than something a contributor has to fabricate a
   * citation to avoid.
   */
  Undecided: "undecided",
} as const;
export type SurfaceMastery =
  (typeof SurfaceMastery)[keyof typeof SurfaceMastery];

/** The `packages/app` export that owns a surface's whole feature body. */
export type CompleteSurfaceOwner = {
  /** Repo-relative path of the owning module. */
  readonly module: string;
  /** Its exported component name. */
  readonly exportName: string;
};

/** A temporary, owner-tagged host composition of a surface-owned concern. */
export type AcceptedHostComposition = {
  readonly concern: SurfaceOwnedConcernType;
  /** AST reference cap; one approved import plus one JSX render usually counts as 2. */
  readonly maxReferences: number;
  readonly module: string;
  readonly owner: string;
};

type MasteredSurface = {
  readonly mastery: typeof SurfaceMastery.Mastered;
  readonly owner: CompleteSurfaceOwner;
  readonly webHost: string;
  readonly desktopHost: string;
  readonly acceptedHostComposition?: readonly AcceptedHostComposition[];
  /**
   * Superseded compositions that STILL SERVE this route behind a retiring flag.
   *
   * Without this field, "mastered" would be a claim about the host a reader
   * chose to name rather than about the route. Sessions and Branches are in the
   * same real state — a v2 surface behind `grid-table-v2`, a v1 fork when it is
   * off — but Branches keeps both branches in ONE file while Sessions split
   * its into siblings. Naming only the v2 files would have left Branches
   * reporting four bypasses and Sessions reporting none, from the same
   * underlying reality, purely because of where the code sits.
   *
   * So these are audited by `no-bypassed-complete-surface` exactly like the
   * primary hosts, and their existing bypasses are allowlisted with the reason.
   * The route stays `Mastered` because PRD-730 names both as the reference
   * composites; what this field adds is that the claim is about the surface,
   * not a promise that nothing else renders the route today. Deleting these is
   * ISS-9415 (wave-fs-5-validation), not this wave.
   */
  readonly legacyHosts?: readonly string[];
};

type PartialSurface = {
  readonly mastery: typeof SurfaceMastery.Partial;
  /** Null when neither host has a shared body at all. */
  readonly owner: CompleteSurfaceOwner | null;
  readonly webHost: string;
  readonly desktopHost: string;
  /** What a host still composes or decides. Required — this is the whole point. */
  readonly gap: string;
};

type SingleHostSurface = {
  readonly mastery: typeof SurfaceMastery.SingleHost;
  /** The host it IS reachable on. Cross-checked against both shell maps. */
  readonly host: ShellNavigationSurface;
  readonly owner: CompleteSurfaceOwner | null;
  /** Repo-relative host path on {@link host}. */
  readonly presentHost: string;
  /** What the absent host lacks, and which issue owns closing it. */
  readonly missingCapability: string;
};

type IntentionallyExcludedSurface = {
  readonly mastery: typeof SurfaceMastery.IntentionallyExcluded;
  /** WHERE the decision is recorded. A rationale with no citation is invention. */
  readonly decision: string;
};

type UndecidedSurface = {
  readonly mastery: typeof SurfaceMastery.Undecided;
  /** What needs deciding, and why this registry will not decide it. */
  readonly escalation: string;
};

export type CompleteSurfaceEntry =
  | MasteredSurface
  | PartialSurface
  | SingleHostSurface
  | IntentionallyExcludedSurface
  | UndecidedSurface;

/**
 * ISS-9395 AC1 — exhaustive over {@link ShellNavigationRouteId} by `satisfies`.
 *
 * A route id added to the shell contract and not to this map fails `tsc` here,
 * and the union above then forces the specific fields its classification needs:
 * a `Mastered` entry cannot omit its owner or either host, a `SingleHost` entry
 * cannot omit the missing capability, and an `IntentionallyExcluded` entry
 * cannot omit its citation. That is what makes "adding a route classifies it or
 * fails" a compile-time fact rather than a convention.
 */
export const COMPLETE_SURFACE_REGISTRY = {
  /**
   * PRD-730 baseline: "Shared bodies already exist for Dashboard/Insights,
   * Agents, Packs and Routines, but host wrappers still choose visible
   * structure or state." ISS-9396 reconciles the host capabilities and
   * ISS-9397 masters it as DashboardSurfaceV2.
   */
  [ShellNavigationRouteId.Dashboard]: {
    mastery: SurfaceMastery.Partial,
    owner: null,
    webHost: "apps/app/app/(authenticated)/[orgSlug]/dashboard/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/dashboard/first-launch-dashboard.tsx",
    gap: "Neither host mounts one shared body. Desktop composes ~20 shared pieces from @repo/app/insights (DashboardRowContent, AiImpactCard, dashboard-tiles) inside its own PageShell/DashboardHeaderActions/AnalyzingBar chrome, and owns its own loading, error and empty renders. ISS-9397 masters it as DashboardSurfaceV2.",
  },
  /**
   * The reference direction. PRD-730: "Named complete list composites exist for
   * Sessions and Branches only". ISS-9216 gave the surface its pagination and
   * ISS-9218 barred `notSupported` on its presentation props.
   */
  [ShellNavigationRouteId.Sessions]: {
    mastery: SurfaceMastery.Mastered,
    owner: {
      module:
        "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
      exportName: "SessionsListSurfaceV2",
    },
    webHost: "apps/app/components/agent-sessions/sessions-list-v2-host.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx",
  },
  [ShellNavigationRouteId.Branches]: {
    mastery: SurfaceMastery.Mastered,
    owner: {
      module: "packages/app/branches/components/branches-list-surface-v2.tsx",
      exportName: "BranchesListSurfaceV2",
    },
    webHost: "apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/branches/branches-view.tsx",
    // ISS-10301 retired the fork the ISS-9427 `acceptedHostComposition`
    // allowance existed for. Branches kept its v1 arm INSIDE these two hosts
    // rather than in sibling files, so it had no separate legacy host to name;
    // the arm is gone, neither host references
    // `branches/components/branches-list-summary-band` any more, and all four of
    // its allowlist seeds came off with it. An allowance that grants nothing is
    // removed rather than left to read as a live exception.
  },
  /**
   * ISS-9406 built `InboxSurfaceV2` and made the web route a thin adapter, so
   * the BODY is now shared. The classification stays `SingleHost` because
   * mastery is a claim about a route on BOTH hosts and desktop reaches this one
   * on neither — the shape `Plans` already carries from the other side. The
   * ticket's condition for adding the desktop destination is an adapter that can
   * supply the same population and read-state commands; `missingCapability` is
   * the evidence it cannot, and PRD-702 is where that changes.
   */
  [ShellNavigationRouteId.Inbox]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: {
      module: "packages/app/inbox/components/inbox-surface-v2.tsx",
      exportName: "InboxSurfaceV2",
    },
    presentHost: "apps/app/app/(authenticated)/[orgSlug]/inbox/inbox-host.tsx",
    missingCapability:
      "Desktop has no Inbox nav id or view: DESKTOP_SHELL_ROUTE_NAV_IDS maps it to null and the renderer tree contains no inbox component, so an /inbox href is dropped by handleUnmappedHref. ISS-9406 moved the body into InboxSurfaceV2, so what desktop still owes is a notification SOURCE — records in the Liveblocks record shape the rows read, an unread tally, a mark-all-read command, and a Liveblocks client context for the rows' own user resolver — rather than a second composition. Evidence of a real coupling, not a recorded reason: apps/desktop declares neither @repo/collaboration nor @liveblocks/*, imports neither anywhere, and its main process ships transient OS notifications (session-terminal-notification.ts, loop-completed) that carry no id and so nothing to mark read; apps/api exposes no notification read route, and @repo/collaboration/server/inbox-notifications.ts is server-only and send-only. PRD-730 assigns ISS-9406 (wave-fs-2-web-to-desktop); PRD-702 owns desktop notification delivery and is what supplies the population and the read-state commands this entry is waiting on.",
  },
  /**
   * The one route absent from BOTH shell maps. PRD-730's scope inventory reads
   * "Included: all shared shell route identities except the unused MyIssues
   * placeholder" — the only route the parent PRD excludes by name.
   */
  [ShellNavigationRouteId.MyIssues]: {
    mastery: SurfaceMastery.IntentionallyExcluded,
    decision:
      'PRD-730 scope inventory: "Included: all shared shell route identities except the unused MyIssues placeholder." That sentence is the WHOLE basis for this classification, and it is the parent PRD\'s call to make. The corroborating code fact is narrow but real: MyIssues is the only route id both WEB_SHELL_ROUTE_HREFS and DESKTOP_SHELL_ROUTE_NAV_IDS map to null, so it names a nav item that resolves to no route on either host. Recorded so a later reader does not over-read the citation: the codebase does NOT itself call it a placeholder anywhere — the item is a fully-formed Labs route descriptor with a label and icon, and its only tests pin it as distinct from My Tasks (which the two have been confused before, #4099). If the PRD sentence is ever revised, this entry has nothing else holding it up and must be reclassified rather than left standing.',
  },
  [ShellNavigationRouteId.Insights]: {
    mastery: SurfaceMastery.Partial,
    owner: null,
    webHost: "apps/app/app/(authenticated)/[orgSlug]/insights/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/insights/desktop-insights-bounded-view.tsx",
    gap: "Desktop mounts the shared SyncedSessionsTable but composes the page itself: its own PageShell/Card chrome, its own TablePagination from @repo/design-system beside the table, and a click-to-load preflight gate before any read. PRD-730 product decision 3 keeps that preflight until bounded-read evidence approves automatic loading; ISS-9399 proves the source and ISS-9400 certifies InsightsPage for both hosts.",
  },
  [ShellNavigationRouteId.Approvals]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Desktop,
    owner: null,
    presentHost:
      "apps/desktop/src/renderer/components/approvals/ApprovalsPanel.tsx",
    missingCapability:
      "Web has no Approvals route: WEB_SHELL_ROUTE_HREFS maps it to null. The desktop panel imports nothing from @repo/app, so there is no shared body to mount. Evidence of a real coupling, not a recorded reason: it drives seven preload IPC calls (getPendingApprovals, approveApproval, denyApproval, alwaysAllowApproval, clearPendingApprovals, removeAlwaysAllowRule, getSettings) and reads its always-allow rules out of desktop local settings. PRD-730 assigns ISS-9408 (wave-fs-3-desktop-to-web) to master Approvals and Requests as a shared queue-surface family.",
  },
  [ShellNavigationRouteId.Requests]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Desktop,
    owner: null,
    presentHost:
      "apps/desktop/src/renderer/components/activity/ActivityPanel.tsx",
    missingCapability:
      "Web has no Requests route: WEB_SHELL_ROUTE_HREFS maps it to null. Evidence of a real coupling, not a recorded reason: the panel renders the local gateway request log over two preload IPC calls (getActivityEvents, clearActivityEvents) and types its payloads from the desktop-internal shared/activity-panel-contract. PRD-730 assigns ISS-9408 alongside Approvals.",
  },
  [ShellNavigationRouteId.Documents]: {
    mastery: SurfaceMastery.Mastered,
    owner: {
      module:
        "packages/app/documents/components/index/documents-index-surface.tsx",
      exportName: "DocumentsIndexSurface",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/documents/components/documents-page-surface.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/documents/documents-view.tsx",
  },
  [ShellNavigationRouteId.Issues]: {
    mastery: SurfaceMastery.Mastered,
    owner: {
      module: "packages/app/issues/components/issues-index-view.tsx",
      exportName: "IssuesIndexView",
    },
    webHost: "apps/app/app/(authenticated)/[orgSlug]/issues/page.tsx",
    desktopHost: "apps/desktop/src/renderer/components/issues/issues-view.tsx",
  },
  /**
   * ISS-9398 built `AgentsListSurfaceV2` out of the 893-line workspace and gave
   * it the toolbar, filters, metric strip, table, state ladder and pagination
   * outright. The two seams that kept this Partial are gone: desktop no longer
   * hands over a `pluginsFooter` node (it declares a plugin-management
   * capability the surface places), and neither host can omit the persistence
   * key or the row route, because both are required.
   *
   * Like Branches, the superseded composition lives INSIDE the two primary
   * hosts rather than in sibling files — each host reads
   * `agent-ops-complete-surface` once and picks between `AgentsListSurfaceV2`
   * and `AgentsGroupedList` — so there is no separate legacy host to name and
   * both forks are already audited by `no-bypassed-complete-surface`.
   *
   * `webHost` is the client adapter, not `agents/page.tsx`: the page is a Server
   * Component that owns the route gate and the breadcrumb chrome, and the mount
   * has to sit under `"use client"`.
   */
  [ShellNavigationRouteId.Agents]: {
    mastery: SurfaceMastery.Mastered,
    owner: {
      module:
        "packages/app/agents/components/workspace/agents-list-surface-v2.tsx",
      exportName: "AgentsListSurfaceV2",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/agents/components/agents-list-host.tsx",
    desktopHost: "apps/desktop/src/renderer/components/agents/agents-view.tsx",
  },
  [ShellNavigationRouteId.MyTasks]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: null,
    presentHost: "apps/app/app/(authenticated)/[orgSlug]/my-tasks/page.tsx",
    missingCapability:
      "Desktop has no My Tasks view: DESKTOP_SHELL_ROUTE_NAV_IDS maps it to null and route-table.ts carries /my-tasks only as a LEGACY ALIAS that redirects to Sessions, so the path resolves but the surface does not exist. PRD-730 records the web route as 800 lines owning data policy, view state and presentation; ISS-9405 extracts MyTasksSurfaceV2.",
  },
  [ShellNavigationRouteId.Packs]: {
    mastery: SurfaceMastery.Partial,
    owner: {
      module: "packages/app/packs/components/packs-page.tsx",
      exportName: "PacksPage",
    },
    webHost: "apps/app/app/(authenticated)/[orgSlug]/packs/page.tsx",
    desktopHost: "apps/desktop/src/renderer/components/packs/packs-view.tsx",
    gap: "Both hosts mount PacksPage and PRD-730 product decision 4 names it the production surface owner, but it is not yet certified as the master and each host passes its own adminView/memberView nodes. ISS-9401 certifies it and reconciles the superseded packs prototype fork.",
  },
  [ShellNavigationRouteId.LostWork]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: null,
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/insights/lost-work/page.tsx",
    missingCapability:
      "Desktop has no Lost Work nav id or view: DESKTOP_SHELL_ROUTE_NAV_IDS maps it to null. PRD-730 assigns ISS-9407 (wave-fs-2-web-to-desktop) to master Lost Work, TokenOps Waste and Judges together as portable analytics surfaces.",
  },
  [ShellNavigationRouteId.TokenOpsWaste]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: null,
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/insights/tokenops-waste/page.tsx",
    missingCapability:
      "Desktop has no TokenOps Waste nav id or view: DESKTOP_SHELL_ROUTE_NAV_IDS maps it to null. PRD-730 assigns ISS-9407 alongside Lost Work and Judges.",
  },
  [ShellNavigationRouteId.Judges]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Web,
    owner: null,
    presentHost:
      "apps/app/app/(authenticated)/[orgSlug]/judges-analytics/page.tsx",
    missingCapability:
      "Desktop has no Judges nav id or view: DESKTOP_SHELL_ROUTE_NAV_IDS maps it to null. PRD-730 assigns ISS-9407 alongside Lost Work and TokenOps Waste.",
  },
  [ShellNavigationRouteId.Plans]: {
    mastery: SurfaceMastery.SingleHost,
    host: ShellNavigationSurface.Desktop,
    owner: {
      module: "packages/app/agents/components/plans/light-plans-shell.tsx",
      exportName: "LightPlansShell",
    },
    presentHost: "apps/desktop/src/renderer/components/features/PlansView.tsx",
    missingCapability:
      "Web has no Plans route: WEB_SHELL_ROUTE_HREFS maps it to null. The body is ALREADY shared — the desktop view is a data adapter over IPC around LightPlansShell — so what web lacks is a mount and a transport, not a component. PRD-730 assigns ISS-9409 alongside Audit.",
  },
  /**
   * ISS-10004 built `DiagnosticsSurfaceV2` and mounted it on desktop;
   * ISS-10006 mounted the SAME export on web, so both hosts now reach it and
   * the classification is {@link SurfaceMastery.Mastered}.
   *
   * The hosts differ in what they can supply, and that difference is recorded
   * rather than hidden: desktop has the probe — one local read over this
   * machine's gateway store — and web has none, because a browser cannot reach
   * that store and the cloud holds no record of it. Per the ISS-10006 treatment
   * ruling of 2026-09-22 web states that per section through `unservableReason`
   * instead of rendering an empty body, and supplies a Gateway Logs explanation
   * in place of the four privileged log calls. Recorded in the CONTRACT, not
   * here and not in a `notSupported` ledger — this surface deliberately has
   * none, because every prop is required. Mastery is not about that difference
   * anyway: it is a claim about who COMPOSES the body, and that is one export.
   *
   * FEA-976 still owns unifying system check, diagnostics and repair actions.
   */
  [ShellNavigationRouteId.Diagnostics]: {
    mastery: SurfaceMastery.Mastered,
    owner: {
      module: "packages/app/diagnostics/components/diagnostics-surface-v2.tsx",
      exportName: "DiagnosticsSurfaceV2",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/diagnostics/components/diagnostics-surface-host.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/diagnostics/diagnostics-surface-host.tsx",
    // `diagnostics-complete-surface` is closed by DEFAULT, which is not the
    // same as closed for everyone: the superseded desktop body serves this
    // route only for readers the key resolves OFF for, and a rollout can put
    // readers on either side of that at any time. What the rollout is right now
    // belongs to the flag sweep, not to this file. Naming the legacy host is
    // what arms `no-bypassed-complete-surface` on it, the same way Sessions
    // names its v1 host — a promotion that left it out would claim the route is
    // mastered while a file many readers still see went unaudited.
    legacyHosts: [
      "apps/desktop/src/renderer/components/diagnostics/diagnostics-legacy-body.tsx",
    ],
  },
  [ShellNavigationRouteId.Settings]: {
    mastery: SurfaceMastery.Partial,
    owner: null,
    webHost: "apps/app/app/(authenticated)/[orgSlug]/settings/page.tsx",
    desktopHost:
      "apps/desktop/src/renderer/settings-v2/desktop-settings-v2-root.tsx",
    gap: "Both hosts now compose the SHARED Settings v2 panel registry — ISS-10246 deleted the desktop legacy Tabs panel, whose four machine-local control blocks ISS-10286 had already re-homed onto the v2 Labs/Desktop App panel. What is still separate is the panel SET each host registers and the chrome around it, plus the legacy web Settings tree that docs/runbooks/settings-v2-legacy-removal-checklist.md still gates. ISS-8370 owns the cross-surface assembly.",
  },
  /**
   * ISS-10005 built `HelpSurfaceV2` and mounted it on desktop; ISS-10006
   * mounted the SAME export on web, so both hosts reach it and it is
   * {@link SurfaceMastery.Mastered}.
   *
   * No host-capability difference to record, which is the finding ISS-10006's
   * prototype produced: every Help capability is a docs read, and the corpus
   * desktop snapshots into its bundle is the one `apps/web` publishes. The two
   * transports differ — four IPC calls against a packed snapshot, three HTTP
   * reads against the deployment.
   *
   * ONE THING ABOVE THE TRANSPORT DIFFERS, and it is named rather than claimed
   * away (tamsinb/whitlockk review). Both indexes tokenize the query, AND the
   * terms, match the nav group and clamp the result set, so the same words
   * return the same pages; they RANK them differently, because web puts a
   * heading hit first — that is the only hit carrying a `headingSlug`, and the
   * slug is what turns "open the page" into "land on the section". Desktop
   * weights the title above it. Both are matters of ordering, neither changes
   * which pages come back, and the divergence lives in one file
   * (`apps/app/lib/docs-help/docs-search.ts`) with the reason beside it.
   */
  [ShellNavigationRouteId.Help]: {
    mastery: SurfaceMastery.Mastered,
    owner: {
      module: "packages/app/help/components/help-surface-v2.tsx",
      exportName: "HelpSurfaceV2",
    },
    webHost:
      "apps/app/app/(authenticated)/[orgSlug]/help/components/help-surface-host.tsx",
    desktopHost:
      "apps/desktop/src/renderer/components/help/help-surface-host.tsx",
    // Same reason as Diagnostics above: `help-complete-surface` is default OFF.
    legacyHosts: [
      "apps/desktop/src/renderer/components/help/help-legacy-body.tsx",
    ],
  },
} as const satisfies Record<ShellNavigationRouteId, CompleteSurfaceEntry>;

/**
 * One audited host of a `Mastered` surface, and the owner it is expected to
 * reach.
 *
 * `ownerModule` is null for a {@link MasteredSurface.legacyHosts} entry and
 * only for those: a legacy host serves the route through the SUPERSEDED
 * composition by definition, so requiring it to mount the master would be
 * demanding the wave-5 deletion that ISS-9415 owns. A PRIMARY host carries the
 * owner module, because "this route is mastered" is a claim about that file
 * mounting that component — and a claim nothing checks is a sentence.
 */
export type MasteredSurfaceHostBinding = {
  /** Repo-relative host path. */
  readonly host: string;
  /** Repo-relative owner module this host must reach, or null for a legacy host. */
  readonly ownerModule: string | null;
};

/**
 * Every `Mastered` host across the registries passed in, paired with the owner
 * it must mount. This is the audited set `no-bypassed-complete-surface` reads.
 *
 * Takes the registries as an argument rather than closing over the shell one,
 * so a contextual `Mastered` family is audited on the same terms the moment one
 * is classified. A `Partial` route is deliberately excluded: its shared body is
 * by definition not yet the whole surface, so a host composing beside it is
 * describing today's reality rather than bypassing a finished contract.
 *
 * Derived rather than restated. A second hand-written list of hosts is the SSOT
 * drift this module exists to end, and it would go stale in the one direction
 * that matters — a newly mastered route the gate had never heard of.
 */
export function masteredSurfaceHostBindings(
  registries: readonly Readonly<Record<string, CompleteSurfaceEntry>>[]
): readonly MasteredSurfaceHostBinding[] {
  const bindings = new Map<string, string | null>();
  for (const registry of registries) {
    for (const entry of Object.values(registry)) {
      if (entry.mastery !== SurfaceMastery.Mastered) {
        continue;
      }
      bindings.set(entry.webHost, entry.owner.module);
      bindings.set(entry.desktopHost, entry.owner.module);
      for (const legacy of entry.legacyHosts ?? []) {
        // A legacy host of one route must never be silently promoted to
        // owner-reaching by ALSO being some other route's primary host — set it
        // only when nothing has claimed it.
        if (!bindings.has(legacy)) {
          bindings.set(legacy, null);
        }
      }
    }
  }
  return [...bindings.keys()]
    .sort()
    .map((host) => ({ host, ownerModule: bindings.get(host) ?? null }));
}

/** Just the host paths of {@link masteredSurfaceHostBindings}, sorted. */
export function masteredSurfaceHosts(
  registries: readonly Readonly<Record<string, CompleteSurfaceEntry>>[]
): readonly string[] {
  return masteredSurfaceHostBindings(registries).map((binding) => binding.host);
}
