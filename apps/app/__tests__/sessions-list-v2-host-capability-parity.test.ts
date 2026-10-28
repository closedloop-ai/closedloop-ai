/**
 * ISS-8636 — a host that stops wiring a capability fails HERE instead of
 * vanishing from the product.
 *
 * The favourite star, the custom-field affordance and the list/board toggle all
 * left the live Sessions page at once and nothing anywhere failed: the surface
 * reads every affordance off a prop's mere presence, so an omitted prop renders
 * no control, which is indistinguishable from a surface that never had one. The
 * operator found three at once by looking at the product.
 *
 * ISS-8635 audited all 47 optional props against both production hosts; these
 * two ledgers ARE that audit, kept executable. Each entry is `SUPPLIED` — the
 * host wires it, and dropping it fails — or `notSupported` with the reason it is
 * honestly absent here, which is what lets a real gap stay recorded without
 * disabling the check. The set has moved since — `changePrFiltersEnabled` left
 * with the `sessions-change-pr-filters` gate, which retired ON, so the Changes /
 * Pull request facets are unconditional and there is no capability left for a
 * host to wire or withhold; `renderTags` arrived with ISS-8712's Tags column,
 * wired by the web v2 host behind `sessions-artifact-tags`; ISS-9107 added
 * `maxSortRules`; ISS-9074 added `maxOffset`, the host's own offset ceiling,
 * supplied by both surface hosts. The live count is not restated here, because a number in this
 * prose is one nothing checks: "reads a non-empty capability set from both
 * sources" asserts every ledger against the surface's own declaration.
 *
 * Both layers are covered because a capability can die at either: the page can
 * stop passing `exportItem` while the host still forwards its own `exportItem`
 * prop, and only the page's ledger would notice.
 *
 * The check can fail because its three inputs are three different sources — the
 * component's own source, the host's JSX, and these hand-written ledgers. Adding
 * a host is one more entry, not a new mechanism — ISS-9107 added the desktop v2
 * branch that way. The differ still lives here rather than in a package both
 * shells can reach, because it reads every host's JSX off DISK: the desktop tree
 * never has to import this app's test support.
 *
 * ISS-9218 added a FOURTH input, and it is the one a ledger cannot argue with:
 * the surface's own capability-kind map, `satisfies`-bound to its prop type. A
 * `presentation` prop — the five `initial*` seeds — cannot be `notSupported`-ed
 * away by any host, because no host is unable to pass one; it is supplied, or
 * declared inert behind a companion this differ checks against the same ledger.
 * That is what `pageSizeOptions: { notSupported: "See onPageSizeChange." }` was
 * hiding in: a pointer, not a justification, over a ladder web supplied and
 * desktop did not. ISS-9216 then retired `pageSizeOptions` and
 * `paginationReadout` outright — the surface owns both — so the sixth
 * presentation prop is gone and the class check now rests on the seeds alone.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { SESSIONS_LIST_SURFACE_V2_CAPABILITY_KINDS } from "@repo/app/agents/components/sessions/sessions-list-surface-v2-capability-kinds";
import { PRESENTATION } from "@repo/app/shared/lib/surface-capability-kind";
import { describe, expect, it } from "vitest";
import { SESSIONS_LIST_V2_HOST_CAPABILITY_KINDS } from "../components/agent-sessions/sessions-list-v2-host-capability-kinds";
import { AGENT_INVOCATIONS_SURFACE_LEDGER } from "./support/agent-invocations-surface-ledger";
import { propsPassedToImported } from "./support/jsx-mount-props";
import {
  capabilityDrift,
  declaredOptionalProps,
  type HostCapabilityLedger,
  productionMountsOf,
  SUPPLIED,
  unledgeredMounts,
} from "./support/surface-capability-parity";

const REPO_ROOT = path.join(process.cwd(), "..", "..");
const SEARCH_ROOTS = ["apps", "packages"];
/** The first ledger pays a full `apps` + `packages` walk; the rest reuse it. */
const REPO_WALK_TIMEOUT_MS = 60_000;

/** Blocked on the write endpoints ISS-8648 / ISS-8649 add; ISS-8650 parks saved views. */
const GET_ONLY =
  "Both Sessions routes are GET-only; ISS-8648/ISS-8649 add the write endpoints.";
/**
 * ISS-9218: the `initial*` seeds are PRESENTATION — any host could pass one — so
 * "notSupported" was never true of them. What is true is that this host supplies
 * `controlledView`, whose value is the whole seed. Declared as a dependency the
 * guard checks rather than a sentence it believes: a host that stops driving the
 * surface through a controller has to seed it again, and reddens here until it
 * does.
 */
const INERT_UNDER_CONTROLLED_VIEW = { inertUnder: "controlledView" } as const;
/**
 * ISS-9218: both toolbar slots, on both hosts, in one sentence rather than a
 * pair where the second one only said "See toolbarPrimary."
 */
const NO_TOOLBAR_SLOT_CONTROL =
  "This host places no control in either toolbar slot — it has no action that belongs beside the table's own controls — and both omitted renders the shipped toolbar exactly.";
/** ISS-9107: the desktop shell reads local SQLite and has no cloud record to back these. */
const DESKTOP_CLOUD_RECORD =
  "Cloud-owned: custom fields, projects and tags live on the cloud artifact record, which a local-mode session row has none of. The v1 desktop table renders none of them either.";
/** Local IPC exposes no regroup or inline-create write; cloud tag writes use HTTP. */
const DESKTOP_NO_WRITE =
  "The desktop Sessions IPC exposes no drag-regroup or inline-create write.";

const WEB_SURFACE_LEDGER: HostCapabilityLedger = {
  componentModule:
    "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  componentName: "SessionsListSurfaceV2",
  componentPath:
    "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
  hostPath: "apps/app/components/agent-sessions/sessions-list-v2-host.tsx",
  kinds: SESSIONS_LIST_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    bulkActions: SUPPLIED,
    className: {
      notSupported:
        "The page owns the surface's outer box; the surface needs no class from here.",
    },
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    controlledView: SUPPLIED,
    customDateWindow: SUPPLIED,
    customFields: SUPPLIED,
    errorRecoveryAction: SUPPLIED,
    exportItem: SUPPLIED,
    favorites: SUPPLIED,
    getSessionHref: SUPPLIED,
    groupDrop: { notSupported: GET_ONLY },
    groupOptions: SUPPLIED,
    hasConnectedAgent: SUPPLIED,
    hasSessionsOutsideWindow: SUPPLIED,
    hiddenSummaryCards: SUPPLIED,
    includeProjectFilter: SUPPLIED,
    initialDateRange: INERT_UNDER_CONTROLLED_VIEW,
    initialFacets: INERT_UNDER_CONTROLLED_VIEW,
    initialGrouping: INERT_UNDER_CONTROLLED_VIEW,
    initialScopeUserId: INERT_UNDER_CONTROLLED_VIEW,
    initialSearch: INERT_UNDER_CONTROLLED_VIEW,
    inlineCreate: { notSupported: GET_ONLY },
    isError: INERT_UNDER_CONTROLLED_VIEW,
    isLoading: SUPPLIED,
    isPending: SUPPLIED,
    isPlaceholderPage: SUPPLIED,
    isSyncing: {
      notSupported:
        "Desktop-only: it reports the local session source hydrating, which the cloud read has no analogue for. Neither web stack has ever wired it.",
    },
    loadingLabel: {
      notSupported:
        "ISS-9106: neither web Sessions stack has ever put words over a pending read — v1 and v2 both show the skeleton — so wiring copy here would ADD a state web does not have today rather than keep parity with one. The desktop stack, which does, supplies it.",
    },
    maxOffset: SUPPLIED,
    maxSortRules: {
      notSupported:
        "There is no rule this page's read drops. ISS-8335 carries every stacked rule onto the wire as `secondarySorts`, and `apps/api/app/agent-sessions/service/session-sort-rules.ts` resolves the whole ordered list server-side, so the cloud query applies exactly what the Sort menu shows. Capping here would retire a working control rather than stop the menu asserting an order the data never took.",
    },
    mode: {
      notSupported:
        "The 'auto' default is the responsive behaviour this page wants; naming a fixed mode would pin it.",
    },
    onAddField: {
      notSupported:
        "The surface already derives it from the supplied customFields controller (`onAddField ?? resolveAddFieldAction(customFields, …)`), which opens the dialog that controller owns. A second callback here would compete with it.",
    },
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onCustomDateWindowChange: SUPPLIED,
    onPageSizeChange: SUPPLIED,
    onResetView: SUPPLIED,
    onRetry: SUPPLIED,
    onTimezoneModeChange: SUPPLIED,
    onToggleSummaryCard: SUPPLIED,
    onboardingAction: SUPPLIED,
    pageInfo: SUPPLIED,
    pageSize: SUPPLIED,
    renderIssues: SUPPLIED,
    // ISS-10332: the cloud projection carries `priority` and the HTTP source
    // writes it back, so the editor is mounted on the live web page.
    renderPriority: SUPPLIED,
    renderProjects: SUPPLIED,
    renderTags: SUPPLIED,
    resolveOwnerName: SUPPLIED,
    resolveProjectName: SUPPLIED,
    savedViews: { notSupported: GET_ONLY },
    selection: {
      notSupported:
        "The surface owns selection uncontrolled; bulk action descriptors receive its current selection through the rail.",
    },
    stallPhase: {
      notSupported:
        "FEA-3639's stall budget is desktop's: it bounds a local SQLite read on a pure-push client with no query-level timeout. This page reads the cloud HTTP source with the shared client's own retry, so it has no stall to report and `useLoadingStall` has no web caller.",
    },
    summaryCards: SUPPLIED,
    tableScrollRef: SUPPLIED,
    timezoneMode: SUPPLIED,
    toolbarPrimary: { notSupported: NO_TOOLBAR_SLOT_CONTROL },
    toolbarTrailing: { notSupported: NO_TOOLBAR_SLOT_CONTROL },
  },
};

const PAGE_HOST_LEDGER: HostCapabilityLedger = {
  componentModule: "@/components/agent-sessions/sessions-list-v2-host",
  componentName: "SessionsListV2Host",
  componentPath: "apps/app/components/agent-sessions/sessions-list-v2-host.tsx",
  hostPath:
    "apps/app/app/(authenticated)/[orgSlug]/sessions/sessions-v2-page.tsx",
  kinds: SESSIONS_LIST_V2_HOST_CAPABILITY_KINDS,
  capabilities: {
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    customDateWindow: SUPPLIED,
    errorRecoveryAction: SUPPLIED,
    exportItem: SUPPLIED,
    getIssueHref: SUPPLIED,
    hasConnectedAgent: SUPPLIED,
    hasSessionsOutsideWindow: SUPPLIED,
    hiddenSummaryCards: SUPPLIED,
    isPlaceholderPage: SUPPLIED,
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onCustomDateWindowChange: SUPPLIED,
    onPageSizeChange: SUPPLIED,
    onResetView: SUPPLIED,
    // ISS-9218 review cid 3937582255: `sessions-empty-state.tsx` renders
    // `errorRecoveryAction ?? onRetry`, so this is dead only while that action is
    // supplied. Declared as the dependency the guard checks, not a sentence: drop
    // the recovery action and this reddens instead of leaving the errored card
    // actionless behind a green ledger.
    onRetry: { inertUnder: "errorRecoveryAction" },
    onTimezoneModeChange: SUPPLIED,
    onToggleSummaryCard: SUPPLIED,
    onboardingAction: SUPPLIED,
    pageInfo: SUPPLIED,
    projectFacetEnabled: SUPPLIED,
    summaryCards: SUPPLIED,
    tableScrollRef: SUPPLIED,
    timezoneMode: SUPPLIED,
  },
};

/**
 * ISS-9107 — the desktop Sessions branch behind `grid-table-v2`.
 *
 * The shell is a local-first Electron app reading its own SQLite store, so most
 * of what it withholds it withholds because the CLOUD owns the record: an
 * artifact id, a custom field, a project, a tag. Those are not gaps waiting on a
 * ticket; they are capabilities this shell has no data for.
 *
 * Two entries ARE gaps, and both are named: `SessionsListSurfaceV2` has no seam
 * for FEA-3639's stall escalation or the table's loading copy, which the v1
 * branch ships. The operator approved mounting without them on 2026-09-03;
 * ISS-9105 and ISS-9106 restore them. They are absent here rather than
 * half-rendered — there is no prop to classify for either, which is exactly why
 * this ledger cannot record them and this comment must.
 */
const DESKTOP_SURFACE_LEDGER: HostCapabilityLedger = {
  componentModule:
    "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  componentName: "SessionsListSurfaceV2",
  componentPath:
    "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
  hostPath:
    "apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx",
  kinds: SESSIONS_LIST_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    bulkActions: SUPPLIED,
    className: SUPPLIED,
    columnOrder: SUPPLIED,
    columnWidths: SUPPLIED,
    controlledView: SUPPLIED,
    customDateWindow: SUPPLIED,
    // ISS-12455: cloud mode reaches the same `apps/api` route web does, so its
    // rows carry `customFields` too — the gap was never the record, it was
    // this host never wiring the seam. Gated off in local mode by
    // `useDesktopSessionsCustomFieldsController`, the same per-mode pattern as
    // `renderPriority`.
    customFields: SUPPLIED,
    errorRecoveryAction: SUPPLIED,
    exportItem: SUPPLIED,
    // ISS-12691: same cloud/local mode gate as `customFields` above — cloud
    // mode's session id IS an artifact id, so Desktop's host calls the shared
    // `useSessionsFavoritesController` the web host calls, with cloud mode as
    // its `enabled`. Local-mode session ids are not artifact ids, so the
    // controller is `undefined` there and the star stays off.
    favorites: SUPPLIED,
    getSessionHref: SUPPLIED,
    groupDrop: { notSupported: DESKTOP_NO_WRITE },
    groupOptions: SUPPLIED,
    hasConnectedAgent: SUPPLIED,
    hasSessionsOutsideWindow: SUPPLIED,
    hiddenSummaryCards: SUPPLIED,
    includeProjectFilter: { notSupported: DESKTOP_CLOUD_RECORD },
    initialDateRange: INERT_UNDER_CONTROLLED_VIEW,
    initialFacets: INERT_UNDER_CONTROLLED_VIEW,
    initialGrouping: INERT_UNDER_CONTROLLED_VIEW,
    initialScopeUserId: INERT_UNDER_CONTROLLED_VIEW,
    initialSearch: INERT_UNDER_CONTROLLED_VIEW,
    inlineCreate: { notSupported: DESKTOP_NO_WRITE },
    isError: INERT_UNDER_CONTROLLED_VIEW,
    isLoading: SUPPLIED,
    isPending: SUPPLIED,
    isPlaceholderPage: SUPPLIED,
    isSyncing: SUPPLIED,
    // ISS-9105 / ISS-9106 restored these two on the surface; PR #6591 landed
    // before this mount, so the reader gets them rather than the absence the
    // operator approved as a temporary state.
    loadingLabel: SUPPLIED,
    maxOffset: SUPPLIED,
    maxSortRules: SUPPLIED,
    mode: {
      notSupported:
        "The 'auto' default is the responsive behaviour this window wants; naming a fixed mode would pin it.",
    },
    onAddField: { notSupported: DESKTOP_CLOUD_RECORD },
    onColumnOrderChange: SUPPLIED,
    onColumnWidthChange: SUPPLIED,
    onCustomDateWindowChange: SUPPLIED,
    // ISS-8756: was `notSupported` because this shell paginated at fixed
    // PAGE_SIZE. The desktop v2 host now supplies the URL-backed handler, so
    // the shared footer control changes the actual list request.
    onPageSizeChange: SUPPLIED,
    onResetView: SUPPLIED,
    onRetry: SUPPLIED,
    onTimezoneModeChange: SUPPLIED,
    onToggleSummaryCard: SUPPLIED,
    onboardingAction: {
      notSupported:
        "The v1 branch passes none either: `hasConnectedAgent` alone drives the onboarding empty, and in local mode the monitor IS the agent so the ask never fires.",
    },
    // ISS-9555: supplied in BOTH desktop modes off one read. Cloud mode reaches
    // the same `apps/api` route the web app does, and local mode's SQLite
    // producer mints the same contract, so there is no half of this shell that
    // has to withhold it.
    pageInfo: SUPPLIED,
    pageSize: SUPPLIED,
    renderIssues: SUPPLIED,
    // ISS-10332: wired off the data-source seam — each source writes a
    // priority when it offers `updatePriority` (cloud HTTP, and the local
    // store since PLN-2086 Milestone 3), and the same JSX expression covers both.
    renderPriority: SUPPLIED,
    renderProjects: SUPPLIED,
    // ISS-12455: same cloud/local mode gate as `customFields` above — cloud
    // rows carry `tags`/`tagAvailability`, local rows carry neither.
    renderTags: SUPPLIED,
    resolveOwnerName: {
      notSupported:
        "One signed-in reader's own sessions; there is no second owner to name and no `?userId=` scope to name one for.",
    },
    resolveProjectName: { notSupported: DESKTOP_CLOUD_RECORD },
    savedViews: {
      notSupported:
        "This shell persists ONE view through `useSessionsViewState('sessions:desktop')` and has no named-view store to list, save into, or delete from.",
    },
    stallPhase: SUPPLIED,
    timezoneMode: SUPPLIED,
    selection: {
      notSupported:
        "The surface owns selection uncontrolled; eligible cloud rows receive the supplied tag action while local rows retain their no-write default.",
    },
    summaryCards: SUPPLIED,
    // ISS-12471: the view publishes the grid band — this route's real scroller
    // — to the App shell's per-href scroll memory.
    tableScrollRef: SUPPLIED,
    toolbarPrimary: { notSupported: NO_TOOLBAR_SLOT_CONTROL },
    toolbarTrailing: { notSupported: NO_TOOLBAR_SLOT_CONTROL },
  },
};

const LEDGERS = [
  WEB_SURFACE_LEDGER,
  PAGE_HOST_LEDGER,
  DESKTOP_SURFACE_LEDGER,
  AGENT_INVOCATIONS_SURFACE_LEDGER,
];

describe.each(LEDGERS)(
  "$hostPath capability parity",
  (ledger: HostCapabilityLedger) => {
    const componentFile = path.join(REPO_ROOT, ledger.componentPath);
    const declaredOptional = declaredOptionalProps(
      readFileSync(componentFile, "utf8"),
      ledger.componentName,
      componentFile
    );
    const supplied = propsPassedToImported(
      readFileSync(path.join(REPO_ROOT, ledger.hostPath), "utf8"),
      ledger.componentModule,
      ledger.componentName
    );

    it("classifies every optional capability, and every claim matches the JSX", () => {
      expect(
        capabilityDrift({ declaredOptional, ledger, supplied })
      ).toStrictEqual([]);
    });

    // A ledger that drifted to empty, or a reader that returned nothing, would
    // satisfy the check above forever.
    it("reads a non-empty capability set from both sources", () => {
      expect(declaredOptional.size).toBeGreaterThan(0);
      expect(supplied.size).toBeGreaterThan(0);
      expect(Object.keys(ledger.capabilities)).toHaveLength(
        declaredOptional.size
      );
      // ISS-9218: the kind map is `satisfies`-bound to the prop TYPE, this reads
      // the same props off the AST. Agreeing here is what stops a prop reaching a
      // ledger with no kind and silently keeping the old escape hatch.
      expect(Object.keys(ledger.kinds)).toHaveLength(declaredOptional.size);
    });
  }
);

/**
 * ISS-9218's counterfactual, kept executable. The desktop ledger carried
 * `pageSizeOptions: { notSupported: "See onPageSizeChange." }` for months while
 * web supplied a ladder, and the guard read that as a valid classification.
 * Restoring exactly that sentence over ANY presentation capability has to fail
 * now, for BOTH reasons — the class and the pointer — or nothing has changed.
 */
describe("the notSupported entry this guard used to accept", () => {
  const presentationProps = Object.keys(
    DESKTOP_SURFACE_LEDGER.capabilities
  ).filter((prop) => DESKTOP_SURFACE_LEDGER.kinds[prop] === PRESENTATION);
  const componentFile = path.join(
    REPO_ROOT,
    DESKTOP_SURFACE_LEDGER.componentPath
  );

  // Not pinned to `pageSizeOptions`: ISS-9216 may retire that prop outright, and
  // a counterfactual that disappears with its subject proves nothing afterwards.
  // Every presentation prop this ledger carries has to reject the same sentence.
  it("has presentation capabilities to mutate", () => {
    expect(presentationProps.length).toBeGreaterThan(0);
  });

  it.each(presentationProps)(
    'reddens when "%s" is notSupported-ed away',
    (prop) => {
      const restored: HostCapabilityLedger = {
        ...DESKTOP_SURFACE_LEDGER,
        capabilities: {
          ...DESKTOP_SURFACE_LEDGER.capabilities,
          [prop]: { notSupported: "See onPageSizeChange." },
        },
      };
      expect(
        capabilityDrift({
          declaredOptional: declaredOptionalProps(
            readFileSync(componentFile, "utf8"),
            restored.componentName,
            componentFile
          ),
          ledger: restored,
          supplied: propsPassedToImported(
            readFileSync(path.join(REPO_ROOT, restored.hostPath), "utf8"),
            restored.componentModule,
            restored.componentName
          ),
        })
      ).toStrictEqual([
        `${restored.hostPath}: capability "${prop}" is presentation on SessionsListSurfaceV2, so "notSupported" cannot be true of it — nothing stops this host passing a value, and omitting it silently swaps in the surface's own default. Pass it, or declare it inertWithout the companion this host withholds.`,
        `${restored.hostPath}: capability "${prop}" gives "See onPageSizeChange." as its notSupported reason, which only points at another entry instead of stating why this host cannot support it. Say what this host lacks, or declare it inertWithout/inertUnder that entry so the guard checks the dependency rather than a reader grading a sentence.`,
      ]);
    }
  );
});

// Without this the audited set would be the array above, and a NEW host would be
// unguarded from birth — the same silence one level up. Desktop's v2 migration
// (ISS-7262) fails here until it is classified, rather than shipping a partial
// Sessions list the way web did.
describe.each(LEDGERS)(
  "$componentName production mounts",
  (ledger: HostCapabilityLedger) => {
    it(
      "has a ledger for every production module that mounts it",
      () => {
        const mounts = productionMountsOf({
          exportName: ledger.componentName,
          moduleSuffix: path.basename(ledger.componentPath, ".tsx"),
          repoRoot: REPO_ROOT,
          searchRoots: SEARCH_ROOTS,
        });
        expect(
          unledgeredMounts({
            componentName: ledger.componentName,
            ledgers: LEDGERS,
            mounts,
          })
        ).toStrictEqual([]);
        // Not vacuous: discovery that found nothing would report no gap forever.
        expect(mounts.length).toBeGreaterThan(0);
      },
      REPO_WALK_TIMEOUT_MS
    );
  }
);
