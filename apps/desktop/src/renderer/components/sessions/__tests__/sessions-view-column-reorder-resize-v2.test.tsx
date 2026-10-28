import { SESSIONS_COST_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  actAndFlush,
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-9935 — column reorder and resize, driven by POINTER and KEYBOARD, on the
 * Electron shell and on the arm production ships when `grid-table-v2` is open.
 *
 * WHY THIS FILE EXISTS, given how much of this is already covered elsewhere.
 * Two suites bound it, and neither reaches what is left:
 *
 *  - `sessions-view-column-reorder.test.tsx` (beside this one) mocks EVERY flag
 *    hook to `false`, so `grid-table-v2` resolves closed and it drives
 *    `SessionsV1View` — the v1 `GridTable` grip, a control v2 does not have at
 *    all. It cannot fail for anything the v2 arm can break.
 *  - `sessions-list-surface-v2-grid-contract.test.tsx` (`@repo/app`) drives the
 *    v2 resize handle and the Move menu, but mounts the shared surface DIRECTLY.
 *    It says nothing about reaching that surface through this shell.
 *
 * The gap between them is shell-specific and this repo has shipped it before: a
 * shared surface newly hosted on a second shell breaks on providers the first
 * shell happened to supply. `sessions-v2-mount.test.tsx` proves the subtree
 * MOUNTS here; nothing proved its reorder and resize controls are OPERABLE once
 * reached through `SessionsView` → `SessionsV2View`.
 *
 * So every case below drives a rendered control and asserts after the call —
 * never that a prop was handed down. The resize cases read the handle's own
 * recomputed accessible name, which is the whole round trip (handle →
 * `onResize` → surface state → re-render → new name) and reddens if any link in
 * it is dropped on this shell. What the PRIMITIVE does with a width — the
 * clamp, the floor wording, the drag arithmetic — is pinned by
 * `grid-table-v2-interactions.test.tsx` and is deliberately not re-asserted.
 */

const LOCAL_SOURCE_READY = {
  localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
};

/**
 * The v2 resize handle names itself with its CURRENT width (ISS-8068). ISS-8909
 * retired the v1 arm, so the width is what the pattern is pinning, not the arm.
 */
const RE_V2_RESIZE_HANDLE = /^Resize .+ column, \d+ pixels wide/;
const RE_STATED_WIDTH = /(\d+) pixels wide/;
/** The v2 keyboard route into reorder: the per-column options menu trigger. */
const COLUMN_OPTIONS_SELECTOR = "button[aria-label$='column options']";
/** The submenu that route opens, and the one item this suite selects from it. */
const MOVE_SUBMENU_ITEM_NAME = "Move column";
const MOVE_TO_END_ITEM_NAME = "Move to end";

const SEEDED_ROWS = [{ id: "iss-9935-a" }, { id: "iss-9935-b" }];

function seedViewState(setColumnOrder: () => void): void {
  sessionsViewHookMocks().useSessionsViewState.mockReturnValue({
    columnOrder: undefined,
    groupBy: "none",
    hiddenSummaryCards: new Set<string>(),
    isViewReady: true,
    resetView: vi.fn(),
    secondarySorts: [],
    setColumnOrder,
    setGroupBy: vi.fn(),
    setSecondarySorts: vi.fn(),
    setSort: vi.fn(),
    sortDir: "desc",
    sortKey: null,
    toggleColumn: vi.fn(),
    toggleSummaryCard: vi.fn(),
    visibleColumns: new Set<string>(["name", "status", "repo"]),
  });
}

function seedSettledRows(): void {
  sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
    data: { list: { ...listWith(SEEDED_ROWS), total: SEEDED_ROWS.length } },
    isError: false,
    isFetching: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });
}

/**
 * jsdom implements no pointer capture and the v2 resize drag captures on press,
 * so the pointer case would throw out of the handler rather than exercise it.
 */
function installPointerCaptureStub(element: Element): void {
  const target = element as Element & {
    hasPointerCapture?: (pointerId: number) => boolean;
    releasePointerCapture?: (pointerId: number) => void;
    setPointerCapture?: (pointerId: number) => void;
  };
  target.hasPointerCapture ??= () => false;
  target.releasePointerCapture ??= () => undefined;
  target.setPointerCapture ??= () => undefined;
}

/**
 * jsdom ships no `DataTransfer`, so the HTML drag lifecycle needs a stand-in
 * that actually carries the column id between `dragstart` and `drop`. Inlined
 * as every sibling column-reorder suite does — `sessions-list-surface-v2-*`,
 * `branches-list-surface-v2`, `grid-table-v2-group-drop` each hold their own
 * copy, and unifying them is a cleanup across three packages rather than part
 * of this change.
 */
function createDataTransfer() {
  const values = new Map<string, string>();
  return {
    dropEffect: "",
    effectAllowed: "",
    types: [] as string[],
    getData(type: string) {
      return values.get(type) ?? "";
    },
    setData(type: string, value: string) {
      values.set(type, value);
      this.types.push(type);
    },
  };
}

/**
 * The lead (identity) column's own header id. Its cell grows a resize handle
 * too, fed by the SEPARATE `leadingResize` seam
 * (`table-grid-header-v2.tsx:325`, from `onLeadingColumnWidthChange`) rather
 * than by the data-column `resize` these cases are about.
 *
 * This exclusion is load-bearing and was found by counterfactual: an unscoped
 * `getAllByRole(...)[0]` returns the LEAD handle, and every case below passed
 * with the data-column `onColumnWidthChange` deleted outright. Scope the query
 * or the suite measures the wrong seam.
 */
const LEADING_COLUMN_ID = "__leading__";

const RESIZE_HANDLE_SELECTOR = "button[aria-label^='Resize ']";

/** Every rendered DATA column header — the lead column excluded, as above. */
function dataColumnHeaders(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="columnheader"][data-column-id]'
    ),
  ].filter((header) => header.dataset.columnId !== LEADING_COLUMN_ID);
}

/**
 * A DATA column's v2 resize handle, and the width its accessible name states.
 *
 * Throws rather than asserts — Biome's `noMisplacedAssertion` forbids `expect`
 * outside a case, and a throw fails the calling case with the same clarity. Each
 * guard below is what stops a case passing vacuously: no data handle at all, or
 * a handle whose name states no width, would otherwise silently compare
 * `undefined` to `undefined`.
 */
function firstDataResizeHandle(): { handle: HTMLElement; widthPx: number } {
  const header = dataColumnHeaders().find(
    (candidate) => candidate.querySelector(RESIZE_HANDLE_SELECTOR) !== null
  );
  const handle = header?.querySelector<HTMLElement>(RESIZE_HANDLE_SELECTOR);
  if (!handle) {
    throw new Error("no data column rendered a v2 resize handle");
  }
  const label = handle.getAttribute("aria-label") ?? "";
  const stated = RE_STATED_WIDTH.exec(label);
  if (!(RE_V2_RESIZE_HANDLE.test(label) && stated)) {
    throw new Error(`resize handle states no v2 width: ${label}`);
  }
  return { handle, widthPx: Number(stated[1]) };
}

/**
 * Opens one header's options menu. Radix's trigger opens on POINTERDOWN with
 * button 0, not on click, so a `fireEvent.click` here would leave the menu shut
 * and hand the case a missing-item throw that reads like a wiring failure.
 */
async function openColumnOptions(header: HTMLElement): Promise<void> {
  const trigger = header.querySelector<HTMLElement>(COLUMN_OPTIONS_SELECTOR);
  if (!trigger) {
    throw new Error(
      `no column options trigger on ${header.dataset.columnId ?? "?"}`
    );
  }
  await actAndFlush(() => {
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  });
}

async function renderDesktopSessionsV2(setColumnOrder = vi.fn()) {
  seedViewState(setColumnOrder);
  await renderSessionsView();
  return setColumnOrder;
}

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  seedSettledRows();
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue(LOCAL_SOURCE_READY),
    onDbChanged: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
});

describe("desktop Sessions v2 — resize is operable through this shell", () => {
  it("grows the column on ArrowRight and restates the width in the handle's name", async () => {
    await renderDesktopSessionsV2();

    const before = firstDataResizeHandle();
    await actAndFlush(() => {
      fireEvent.keyDown(before.handle, { key: "ArrowRight" });
    });

    expect(firstDataResizeHandle().widthPx).toBeGreaterThan(before.widthPx);
  });

  it("shrinks it on ArrowLeft, so the keyboard reaches both directions here", async () => {
    await renderDesktopSessionsV2();

    const before = firstDataResizeHandle();
    await actAndFlush(() => {
      fireEvent.keyDown(before.handle, { key: "ArrowLeft" });
    });

    expect(firstDataResizeHandle().widthPx).toBeLessThan(before.widthPx);
  });

  it("tracks a pointer drag on the same handle, so pointer and keyboard agree", async () => {
    await renderDesktopSessionsV2();

    const before = firstDataResizeHandle();
    installPointerCaptureStub(before.handle);
    await actAndFlush(() => {
      fireEvent.pointerDown(before.handle, {
        button: 0,
        clientX: 100,
        pointerId: 1,
      });
      // The move is what sets the pending width; `pointerup` only commits it.
      // Without this the drag would commit width-at-press and "pass" having
      // moved nothing.
      fireEvent.pointerMove(before.handle, { clientX: 160, pointerId: 1 });
      fireEvent.pointerUp(before.handle, { clientX: 160, pointerId: 1 });
    });

    expect(firstDataResizeHandle().widthPx).toBeGreaterThan(before.widthPx);
  });
});

describe("desktop Sessions v2 — reorder is operable through this shell", () => {
  it("drives setColumnOrder from a header drop", async () => {
    const setColumnOrder = await renderDesktopSessionsV2();

    const headers = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="columnheader"][draggable="true"]'
      ),
    ];
    // `draggable` is what `TableGridHeaderV2` sets from `canReorder`, so this
    // selects exactly the movable columns — a sweep of every header would put a
    // pinned one first and make the drop a no-op that still passed.
    expect(headers.length).toBeGreaterThan(1);

    const draggedId = headers[1].dataset.columnId ?? "";
    const targetId = headers[0].dataset.columnId ?? "";

    const dataTransfer = createDataTransfer();
    await actAndFlush(() => {
      fireEvent.dragStart(headers[1], { dataTransfer });
      fireEvent.drop(headers[0], { dataTransfer });
    });

    expect(setColumnOrder).toHaveBeenCalledTimes(1);
    const nextOrder = setColumnOrder.mock.calls[0][0] as string[];
    // The dragged id actually MOVED past its drop target (whitlockk, PR #7110). A
    // length check alone stayed green on the order handed in unchanged, which is
    // the exact shape of a drop whose handler never reordered anything.
    expect(nextOrder.indexOf(draggedId)).toBeLessThan(
      nextOrder.indexOf(targetId)
    );
    // …and the COMPLETE order, not just the visible slice: `mergeColumnOrder` is
    // what the desktop view state stores, so a surface forwarding only the three
    // rendered ids would drop every hidden column from the persisted record.
    // `cost` is hidden here — `seedViewState` makes name/status/repo visible —
    // so its survival is what separates the complete order from the slice.
    expect(nextOrder).toContain(SESSIONS_COST_COLUMN_ID);
  });

  it("gives EVERY pointer-reorderable header the keyboard route too", async () => {
    await renderDesktopSessionsV2();

    // WCAG 2.1.1, stated as parity rather than as a spot check: a column the
    // pointer can move is never rendered without the control that opens the
    // keyboard route to the same operation. A header that is `draggable` with no
    // options button is pointer-only reorder.
    //
    // This case pins the TRIGGER's presence on every such header and nothing
    // further; that the route behind it actually reaches `setColumnOrder` is the
    // case below, which drives it.
    const draggableHeaders = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="columnheader"][draggable="true"]'
      ),
    ];
    expect(draggableHeaders.length).toBeGreaterThan(1);

    const withoutKeyboardRoute = draggableHeaders.filter(
      (header) => header.querySelector(COLUMN_OPTIONS_SELECTOR) === null
    );
    // Named rather than counted, so a failure says WHICH column lost the route.
    expect(
      withoutKeyboardRoute.map((header) => header.dataset.columnId)
    ).toEqual([]);
  });

  it("drives setColumnOrder from the menu's Move item, so the keyboard route is wired and not just present", async () => {
    // davetho, PR #7110. The parity case above cannot see a DISCONNECTED Move
    // handler: the submenu renders on `movable` alone
    // (`table-grid-header-v2-label.tsx:234`) and invokes it as
    // `actions.onMove?.(…)`, so with the handler dropped the trigger and every
    // Move item still render and the click silently no-ops. Only reaching
    // `setColumnOrder` through the item distinguishes the two — verified by
    // blanking `resolvedActions.onMove` (`table-grid-header-v2.tsx:593`), which
    // reddens THIS case alone and leaves the parity case above green.
    //
    // That seam is the composite, and it is the one worth pinning: the route is
    // the host's `headerActions.onMove` OR, when the host supplies none, the
    // primitive's own `moveReorderableColumn` fallback. Dropping just the host
    // half is not a regression here — the fallback still reorders — so this case
    // deliberately asserts the OUTCOME rather than which half produced it.
    const setColumnOrder = await renderDesktopSessionsV2();

    const visibleDataIds = dataColumnHeaders().map(
      (header) => header.dataset.columnId ?? ""
    );
    const moved = dataColumnHeaders().find(
      (header) => header.getAttribute("draggable") === "true"
    );
    if (!moved) {
      throw new Error("no draggable data column to move");
    }
    const movedId = moved.dataset.columnId ?? "";

    await openColumnOptions(moved);
    // ArrowRight is the submenu's keyboard opener, which is the route under test
    // — a pointer hover would prove the mouse path this case is not about.
    const moveSubTrigger = await screen.findByRole("menuitem", {
      name: MOVE_SUBMENU_ITEM_NAME,
    });
    await actAndFlush(() => {
      fireEvent.keyDown(moveSubTrigger, { key: "ArrowRight" });
    });
    const moveToEnd = await screen.findByRole("menuitem", {
      name: MOVE_TO_END_ITEM_NAME,
    });
    await actAndFlush(() => {
      fireEvent.click(moveToEnd);
    });

    expect(setColumnOrder).toHaveBeenCalledTimes(1);
    const nextOrder = setColumnOrder.mock.calls[0][0] as string[];
    // "Move to end" put it behind every other rendered column…
    const othersAfterMove = visibleDataIds
      .filter((id) => id !== movedId)
      .filter((id) => nextOrder.indexOf(id) > nextOrder.indexOf(movedId));
    expect(othersAfterMove).toEqual([]);
    // …in the COMPLETE order, which is what the desktop view state persists.
    expect(nextOrder).toContain(SESSIONS_COST_COLUMN_ID);
  });
});
