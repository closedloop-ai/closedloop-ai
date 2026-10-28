import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type { AgentSessionListPageInfo } from "@repo/api/src/types/agent-session-list-contract";
import type {
  SessionsSeamCellRenderer,
  SessionTableRow,
} from "@repo/app/agents/lib/session-list-row";
import type { GridTableV2Mode } from "@repo/design-system/components/ui/grid-table-v2";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import type {
  TableFieldOption,
  TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { GridRowSelectionController } from "@repo/design-system/hooks/use-grid-row-selection";
import type { ReactNode } from "react";
import type { TimezoneMode } from "../../../shared/lib/date-window-timezone-mode";
import type { DateRange } from "../../../shared/lib/format-utils";
import type { LoadingStallPhase } from "../../../shared/lib/loading-stall-phase";
import type {
  SessionOwnerNameResolver,
  SessionProjectNameResolver,
} from "../../lib/session-active-filter-chips";
import type { SessionCustomDateWindow } from "../../lib/session-custom-date-window";
import type { SessionFacetFilters } from "../../lib/session-filter-adapter";
import type { SessionsCustomFieldsController } from "./sessions-list-custom-fields";
import type {
  SessionsFavoriteController,
  SessionsGroupDropController,
  SessionsInlineCreateController,
} from "./sessions-list-interactions";
import type { SessionsSavedViewsController } from "./sessions-list-saved-views";
import type { SessionsSummaryCardsPassthrough } from "./sessions-list-summary-band";
import type { SessionsListViewController } from "./sessions-list-view-state";

/**
 * The public contract of {@link SessionsListSurfaceV2}, split out of the
 * component module so the surface's implementation and the seams a host may
 * supply are read and reviewed separately.
 *
 * Extracted while merging ISS-8217 into ISS-8335: both branches appended to the
 * component and each stayed under the 1,000-line ceiling alone, but their union
 * crossed it. The seam is the one AGENTS.md asks for -- a responsibility
 * boundary (what a host passes in, versus what the component does with it) --
 * rather than a slice taken at a line count.
 */
export type SessionsListSurfaceV2Props = {
  /**
   * ISS-8942: the bulk operations this surface's rail offers, in order.
   *
   * An array keeps the legacy favourite-prepending path. A builder receives
   * the selected rows and owns the full registry composition, so the surface
   * does not maintain a second action inventory.
   */
  bulkActions?:
    | readonly TableBulkActionDescriptor[]
    | ((
        selectedRows: readonly SessionTableRow[]
      ) => readonly TableBulkActionDescriptor[]);
  className?: string;
  /**
   * FEA-4021: the host's persisted DATA-column order. Supplied alone it only
   * arranges the rendered columns and their grid tracks together; supplied with
   * `onColumnOrderChange` the headers also become drag/keyboard reorder
   * surfaces, which is how `GridTableV2` gates the affordance.
   */
  columnOrder?: readonly string[];
  /**
   * ISS-9567: the host's persisted per-column widths (px), keyed by data-column
   * id, `custom-field:*` ids included (ISS-10356). The sibling of
   * {@link columnOrder} and wired the same way — supplied,
   * the widths a reader drags survive a reload through the host's saved view;
   * omitted, this surface keeps them in its own state for the life of the mount,
   * which is every Sessions resize this product shipped before ISS-9567.
   */
  columnWidths?: Readonly<Record<string, number>>;
  /**
   * ISS-7262: hand the surface's view state to a host that already owns it.
   * Omit for the self-contained default, where the `initial*` props seed state
   * this component then keeps. Supplied, the `initial*` props are inert — the
   * controller's `value` is the whole seed.
   */
  controlledView?: SessionsListViewController;
  /** Host-owned definitions plus batch-loaded values for Session artifacts. */
  customFields?: SessionsCustomFieldsController;
  /** Host-owned recovery affordance for the errored empty (ISS-4534). */
  errorRecoveryAction?: ReactNode;
  /**
   * FEA-4217: the CSV export row, appended to the `trailing` slot of BOTH the
   * wide options menu and the folded one — the narrow menu replaces the wide
   * one rather than sitting beside it, so a row passed to only one of them is
   * unreachable at the other width. A NODE, not a callback, because the real row
   * owns its own `useApiClient()`; a host that cannot export honestly yet omits
   * it rather than offering a control that would hand the reader a file for a
   * view they were never shown.
   */
  exportItem?: ReactNode;
  /** Generic artifact-favorites state for cloud artifact-backed session ids. */
  favorites?: SessionsFavoriteController;
  /**
   * ISS-7262: the route a row's session name links to. Supplied, the lead cell
   * renders a real `@repo/navigation` `Link` — the only navigation mechanism
   * AGENTS.md admits, and the reason this surface could not host a list whose
   * rows a user needs to open.
   *
   * Returns `string | null` so a host with no route FOR THIS ROW can say so and
   * get the plain name, rather than a styled link to `"#"` (FEA-4051). Omitting
   * the seam entirely is the fixture case — a story, a column-geometry test.
   */
  getSessionHref?: (row: SessionTableRow) => string | null;
  /** Mutations available for moving a row between grouped destinations. */
  groupDrop?: SessionsGroupDropController;
  /**
   * The BUILT-IN dimensions the Group control offers. Defaults to every
   * groupable column this surface can render, which is right for the
   * uncontrolled mount — it holds the grouping itself and can round-trip all of
   * them. Groupable custom fields are appended to whatever is passed, since
   * those are a property of the host's field definitions rather than of this
   * list.
   *
   * A CONTROLLED host must narrow this to what its own persisted state can
   * hold: `toSessionsHostViewState` keeps only the primary level and coerces
   * anything outside {@link SESSIONS_HOST_GROUP_OPTION_IDS} back to `None`, so
   * an option the host cannot store is a control that moves and snaps back.
   */
  groupOptions?: readonly TableFieldOption[];
  /** Drives the onboarding vs "no sessions yet" split on a genuine empty. */
  hasConnectedAgent?: boolean;
  /**
   * ISS-11913: the host's `useSessionsOutsideWindow` answer — sessions exist
   * that only the date window hides. Only `true` changes the empty state, to
   * the date-range empty with "Show all time".
   */
  hasSessionsOutsideWindow?: boolean;
  /**
   * ISS-9074: the highest `offset` the HOST's read will accept. Omitted, the
   * paginator advertises every page the row count implies, which is right for a
   * host whose source has no offset ceiling.
   *
   * A host whose read DOES cap the offset must pass that cap, for the same
   * reason {@link maxSortRules} exists: the cloud Sessions route rejects an
   * offset past `SESSION_LIST_MAX_OFFSET` with a 400 (ISS-8528), so the
   * last-page link the footer always renders on a large org is a page that can
   * never load — and the errored page cannot self-repair, because the clamp
   * that would rescue it reads a total the failed query never returned. Capped,
   * the paginator stops at the last page the read can serve; every page below
   * it is unchanged.
   */
  maxOffset?: number;
  /**
   * ISS-9107 (whitlockk review): how many ordering rules the HOST's read can
   * actually apply. Omitted, the Sort control stacks without limit, which is
   * right for a host whose query resolves the whole ordered list.
   *
   * A server-driven host must narrow this to what its query resolves, for the
   * same reason {@link groupOptions} exists: the desktop shell sends only
   * `sortBy`/`sortDir` to its SQLite source, so a second rule is persisted and
   * displayed while the rows underneath it are ordered by the first alone —
   * the menu asserting an ordering the data never took. Capped, every control
   * stays live (direction and Remove still write) and choosing another field
   * REPLACES the rule instead of stacking one the host would drop.
   */
  maxSortRules?: number;
  /**
   * ISS-5355: offer the Project facet. Web-only — a session's project comes from
   * its cloud artifact, which the desktop local producer cannot resolve — so the
   * host reads its own flag and passes the answer, exactly as `SessionsToolbar`
   * takes it. A host that filters by `projectIds` and omits this renders a list
   * narrowed by a facet the reader can neither see nor clear.
   */
  includeProjectFilter?: boolean;
  /**
   * FEA-4217: the summary cards the reader has switched OFF, as the hosts
   * persist them. It reaches the STRIP as well as the menus — a card the menu
   * reports as off while the strip still paints it is the control lying about
   * the view it owns — and hiding every card drops the metric band entirely
   * rather than leaving its padding around nothing.
   *
   * @see onToggleSummaryCard — supplied without a handler this renders no metric
   * rows, because a toggle that cannot report is not a control.
   */
  hiddenSummaryCards?: ReadonlySet<string>;
  /** @see controlledView — inert once a controller is supplied. */
  initialDateRange?: DateRange;
  /** @see controlledView — inert once a controller is supplied. */
  initialFacets?: SessionFacetFilters;
  initialGrouping?: TableGroupingState;
  /**
   * @see controlledView — inert once a controller is supplied.
   * @see SessionsListViewState.scopeUserId
   */
  initialScopeUserId?: string | null;
  /**
   * @see controlledView — inert once a controller is supplied.
   * @see SessionsListViewState.search
   */
  initialSearch?: string;
  /** Optional host-owned session creation seam rendered in the grid's canonical inline row. */
  inlineCreate?: SessionsInlineCreateController;
  /** The row read failed. Feeds the empty state's Unavailable reason. */
  isError?: boolean;
  /** Loading state for the summary strip, forwarded verbatim. */
  isLoading?: boolean;
  /** The row read is in flight; the table region shows a skeleton. */
  isPending?: boolean;
  /** Rows currently belong to the previous page while a new page is loading. */
  isPlaceholderPage?: boolean;
  /** Source is mid-sync rather than errored — a different unavailable copy. */
  isSyncing?: boolean;
  /**
   * ISS-9106: the words over a pending read — {@link SESSIONS_LIST_LOADING_LABEL},
   * or {@link SESSIONS_LIST_SEARCHING_LABEL} when a term is narrowing it. Built by
   * `getSessionsTableLoadingLabel`, which is also what decides there is no
   * label at all.
   *
   * Omitted, the table region keeps its row skeleton. That is honest for a host
   * whose read cannot distinguish these moments, but it does conflate "still
   * loading" with "loaded and genuinely empty" for a reader who looks away and
   * back — which is why a host that CAN name the state is expected to.
   */
  loadingLabel?: string;
  /** Responsive v2 grid/card mode. */
  mode?: GridTableV2Mode;
  /** @see columnOrder — supplying this is what grows the reorder handles. */
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * @see columnWidths — supplying this is what persists a resize, for EVERY
   * column: a custom-field drag is reported here too, so the setter must hold
   * those ids (ISS-10356).
   */
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  /** Controlled page-size change seam for server-driven hosts. */
  onPageSizeChange?: (pageSize: number) => void;
  /**
   * ISS-7052 Part A (tamsinb review): restore this table's shipped default
   * columns, order, grouping and summary cards. The v1 `SessionsToolbar` has
   * offered this since FEA-4021 through `TableViewMenu`'s reset row; the v2
   * surface replaces that whole toolbar, so without this seam a reader who
   * reorders, hides or resizes columns here has no one-click way back — the
   * flag would be taking a shipped capability away rather than swapping a
   * stack. Appended to the `trailing` slot of BOTH menus for the same reason
   * `exportItem` is.
   *
   * Omitted, neither menu renders it: a surface whose view is not persisted has
   * nothing to reset to, and an action that does nothing is worse than absent.
   */
  onResetView?: () => void;
  /**
   * ISS-5316: open the add-custom-field flow from the column menu — BOTH the
   * wide one and the folded one, so the item does not vanish at the `md`
   * boundary. Omitted, neither menu renders it: a table whose columns are fixed
   * must not offer a control that cannot add one.
   */
  onAddField?: () => void;
  onRetry?: () => void;
  /**
   * FEA-4217: toggle one summary card. Supplied WITH the strip's
   * `hiddenCardIds`, both the wide and the folded menu grow metric rows; either
   * alone renders none, because a toggle that cannot report its change is a
   * control that does not work.
   */
  onToggleSummaryCard?: (cardId: string) => void;
  onboardingAction?: ReactNode;
  /**
   * ISS-9555: which page the host's read actually served, as the producer said
   * it. Present, it is authoritative for the rendered position; the surface
   * stops deriving that from the requested page and `totalRows`.
   *
   * Optional because it crosses a version-skewed wire and because not every
   * producer path performs a read. Absent, the surface derives in place exactly
   * as it did before and does NOT ask the host to read again — Sessions has no
   * unpaginated mode to fall back to, so Branches' legacy re-read has no
   * counterpart here.
   */
  pageInfo?: AgentSessionListPageInfo;
  pageSize?: number;
  /**
   * FEA-4209 / FEA-4210: the linked-ISSUES and linked-PROJECT(S) cells, in the
   * same shape `SessionsTable` takes them.
   *
   * Both columns are in {@link SESSIONS_SEAM_REQUIRED_COLUMN_IDS}: their values
   * are cloud-only projections off the raw session record, which a
   * `SessionTableRow` does not carry, so this surface cannot derive them. A seam
   * supplied here re-admits its column to the grid AND to the Show/Hide menu; a
   * seam omitted keeps the column dropped, which is what stops a locally-fed
   * list growing a track of em dashes.
   */
  renderIssues?: SessionsSeamCellRenderer;
  /** @see renderIssues */
  renderProjects?: SessionsSeamCellRenderer;
  /**
   * ISS-8712: the `Tags` cell — the org-tag picker for the row's Session
   * artifact. Seam-required like the pair above, but because the cell WRITES
   * rather than because its data is cloud-only. Absent → the column and its
   * track are dropped.
   */
  renderTags?: SessionsSeamCellRenderer;
  /**
   * ISS-10332: the `Priority` cell — `ArtifactPriorityEditor` over the row's
   * Session artifact, through the host's data source. Seam-required like
   * `renderTags` because the cell writes, and additionally because only a
   * source that projects the field can fill it: the cloud list does, and the
   * local Desktop producer since PLN-2086 Milestone 3. Absent → the column
   * and its track are dropped. Supplied, the column is SHOWN by default
   * (operator ruling 5, 2026-09-21).
   */
  renderPriority?: SessionsSeamCellRenderer;
  /**
   * ISS-4974: resolves an Owner display name for a selected user with no usage
   * row in the active window — the ordinary case for a restored view. Omitted,
   * the chip falls back to the raw id, which names nothing a reader can act on.
   */
  resolveOwnerName?: SessionOwnerNameResolver;
  /**
   * ISS-5355: the Project counterpart to {@link resolveOwnerName}. Omitted, a
   * selected project the active window has no usage row for labels as its raw
   * uuid, which names nothing a reader can act on.
   */
  resolveProjectName?: SessionProjectNameResolver;
  rows: readonly SessionTableRow[];
  /**
   * ISS-9107: the explicit `?from=`/`?to=` window, when the host's URL names one.
   *
   * Supplied, the preset toggle deselects — a preset must never read as selected
   * for a different effective interval — and the window gets a named, clearable
   * control of its own. Omitted, this surface has no explicit window and the
   * preset speaks for the whole read, which is every host that does not own
   * those params.
   */
  customDateWindow?: SessionCustomDateWindow | null;
  /**
   * @see customDateWindow — `null` hands the listing back to the preset. Called
   * BEFORE the view change that "Clear filters" reports, so a host can fold the
   * param strip into that single URL write rather than issuing a second one.
   */
  onCustomDateWindowChange?: (window: SessionCustomDateWindow | null) => void;
  /**
   * ISS-9619 — which day boundary the preset window means for this host.
   *
   * Supplied WITH {@link onTimezoneModeChange}, the toolbar grows a `Local | UTC`
   * control; the host owns the value because the host is what turns a range into
   * the `startDate`/`endDate` its read actually uses, and a mode the surface held
   * privately would re-window the rows while the host's summary read kept the
   * old bounds. Omitted, every window is the UTC calendar day it is today.
   */
  timezoneMode?: TimezoneMode;
  /** @see timezoneMode — the writer whose presence gates the control. */
  onTimezoneModeChange?: (mode: TimezoneMode) => void;
  /** Optional controlled selection; the surface owns ephemeral state otherwise. */
  selection?: GridRowSelectionController;
  /** Host-owned named views. Omit when the host has no persistence adapter. */
  savedViews?: SessionsSavedViewsController;
  /**
   * FEA-3639 / ISS-9105: how long the host's blocking read has been wedged.
   * `soft` keeps the loading affordance but grows a Retry; `hard` replaces it
   * with the actionable "temporarily unavailable" error, so this table can never
   * sit on an endless skeleton.
   *
   * Omitted, the table never escalates — correct only for a host whose read has
   * its own timeout and retry. A host that detects a stall and does not forward
   * it strands the reader on the skeleton, which is the defect FEA-3639 fixed.
   */
  stallPhase?: LoadingStallPhase;
  /**
   * ISS-7355: everything else `SessionsSummaryCards` needs, forwarded verbatim.
   *
   * The strip used to receive `cardClassName`/`isLoading`/`usage` and nothing
   * else, so a host mounting this surface silently LOST five shipped behaviours
   * its own list already had — `deltas`, the ISS-4481 `costUnknownActive`
   * honest-empty Cost tile, the summary read's own `isError`, FEA-3865's
   * `wrapBelow`, and (on desktop) the whole local-mode set. The worst of those
   * is `costUnknownActive`: without it an all-unknown cost cohort sums to a
   * fabricated `$0` rather than saying it could not compute one.
   *
   * A derived pass-through rather than eighteen re-declared props, because the
   * two real hosts already hold these values and `SessionsSummaryCards` owns
   * their meaning. The `Omit` covers exactly the keys this surface answers for
   * itself, so a host cannot fight the strip's layout, double-state its loading,
   * or hand the strip a hidden set the MENUS never saw — all four are applied
   * AFTER this bag and always win. The hidden set arrives as
   * {@link hiddenSummaryCards} precisely because the menus read it too.
   */
  summaryCards?: SessionsSummaryCardsPassthrough;
  /**
   * ISS-7052 Part A: the scrolling table band's element. This surface owns the
   * scroll region the v1 host used to expose to the page, so a host restoring a
   * list position has to be handed it — attaching to anything else observes a
   * container that never scrolls and silently saves nothing.
   */
  tableScrollRef?: (node: HTMLElement | null) => void;
  /**
   * `GridTableToolbar`'s own slots, forwarded so a host can place a control the
   * surface has no opinion about. `primary` survives the narrow fold; `trailing`
   * is the page's primary action. Both omitted renders today's toolbar exactly.
   */
  toolbarPrimary?: ReactNode;
  /** @see toolbarPrimary */
  toolbarTrailing?: ReactNode;
  usage: AgentSessionUsageSummary | undefined;
};
