import { SESSIONS_LIST_SURFACE_V2_CAPABILITY_KINDS } from "@repo/app/agents/components/sessions/sessions-list-surface-v2-capability-kinds";
import {
  type HostCapabilityLedger,
  SUPPLIED,
} from "./surface-capability-parity";

const controlled = { inertUnder: "controlledView" } as const;
const readOnly = {
  notSupported:
    "This component-scoped session read supplies no session creation, regrouping or bulk-write controller.",
} as const;
const noCustomFields = {
  notSupported:
    "This nested host supplies no custom-field schema or field-editing controller for its component-scoped session rows.",
} as const;
const noColumnPersistence = {
  notSupported:
    "This nested host stores filter, sort and grouping view state, but holds no separate column-width or column-order store or writer.",
} as const;
const noTimezoneControl = {
  notSupported:
    "This nested host owns no timezone preference or custom date-window state; its query derives the selected relative date range from controlledView.",
} as const;

export const AGENT_INVOCATIONS_SURFACE_LEDGER: HostCapabilityLedger = {
  componentModule: "../sessions/sessions-list-surface-v2",
  componentName: "SessionsListSurfaceV2",
  componentPath:
    "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
  hostPath:
    "packages/app/agents/components/workspace/agent-invocations-grid.tsx",
  kinds: SESSIONS_LIST_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    bulkActions: readOnly,
    className: SUPPLIED,
    columnOrder: noColumnPersistence,
    columnWidths: noColumnPersistence,
    controlledView: SUPPLIED,
    customDateWindow: noTimezoneControl,
    customFields: noCustomFields,
    errorRecoveryAction: {
      notSupported:
        "Failed component reads retry the same query through onRetry; this host has no separate authentication or source-switch recovery action.",
    },
    exportItem: {
      notSupported:
        "This nested component view has no transcript export adapter or export action.",
    },
    favorites: SUPPLIED,
    getSessionHref: SUPPLIED,
    groupDrop: readOnly,
    groupOptions: {
      notSupported:
        "The nested host supplies no additional grouping vocabulary beyond the surface's built-in session groups.",
    },
    hasConnectedAgent: {
      notSupported:
        "The detail is scoped to an existing component; this host has no agent-connection onboarding state.",
    },
    hasSessionsOutsideWindow: {
      notSupported:
        "The scoped read supplies no second all-time existence probe outside the selected window.",
    },
    hiddenSummaryCards: SUPPLIED,
    includeProjectFilter: {
      notSupported:
        "This host has no project-filter lookup or project-name resolver for the component-scoped query.",
    },
    initialDateRange: controlled,
    initialFacets: controlled,
    initialGrouping: controlled,
    initialScopeUserId: controlled,
    initialSearch: controlled,
    inlineCreate: readOnly,
    isError: SUPPLIED,
    isLoading: {
      notSupported:
        "This query exposes its initial unresolved state through isPending and controlledView.readState, rather than a separate loading signal.",
    },
    isPending: SUPPLIED,
    isPlaceholderPage: {
      notSupported:
        "The scoped query keeps no previous page as placeholder data while a new page loads.",
    },
    isSyncing: {
      notSupported:
        "This nested read has no live collector hydration state or sync-progress subscription.",
    },
    loadingLabel: {
      notSupported:
        "The scoped host supplies no phase-specific loading copy; the surface renders its existing pending skeleton.",
    },
    maxOffset: SUPPLIED,
    maxSortRules: SUPPLIED,
    mode: {
      notSupported:
        "This host has no fixed layout mode; it retains the surface's responsive auto layout.",
    },
    onAddField: noCustomFields,
    onColumnOrderChange: noColumnPersistence,
    onColumnWidthChange: noColumnPersistence,
    onCustomDateWindowChange: noTimezoneControl,
    onPageSizeChange: SUPPLIED,
    onResetView: SUPPLIED,
    onRetry: SUPPLIED,
    onTimezoneModeChange: noTimezoneControl,
    onToggleSummaryCard: {
      notSupported:
        "The component host fixes the hidden metric set and offers no metric-visibility preference writer.",
    },
    onboardingAction: {
      notSupported:
        "This existing-component detail has no connection onboarding action or associated setup flow.",
    },
    pageInfo: SUPPLIED,
    pageSize: SUPPLIED,
    renderIssues: {
      notSupported:
        "This host supplies no issue-link editor or issue-navigation cell adapter.",
    },
    renderPriority: readOnly,
    renderProjects: {
      notSupported:
        "This host supplies no project-membership editor or project-navigation cell adapter.",
    },
    renderTags: noCustomFields,
    resolveOwnerName: {
      notSupported:
        "This host has no separate organization-user directory lookup; it renders the names carried by the scoped rows.",
    },
    resolveProjectName: {
      notSupported:
        "This host has no separate project directory lookup or project filter.",
    },
    savedViews: SUPPLIED,
    selection: {
      notSupported:
        "The surface owns row selection for its supplied favorites; this nested host has no bulk operation requiring lifted selection state.",
    },
    stallPhase: {
      notSupported:
        "This nested host has no local read-stall budget or phase subscription to report.",
    },
    summaryCards: {
      notSupported:
        "The component view supplies scoped usage with a fixed hidden-card set, rather than a second custom card collection.",
    },
    tableScrollRef: {
      notSupported:
        "The component detail owns the surrounding scroller; this nested grid publishes no independent shell scroll-restoration reference.",
    },
    timezoneMode: noTimezoneControl,
    toolbarPrimary: {
      notSupported:
        "This nested component view has no extra toolbar action alongside the surface's filters and saved views.",
    },
    toolbarTrailing: {
      notSupported:
        "This nested component view has no extra trailing toolbar action.",
    },
  },
};
