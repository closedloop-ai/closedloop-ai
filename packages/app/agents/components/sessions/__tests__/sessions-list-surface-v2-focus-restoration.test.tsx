/**
 * ISS-9555 — keyboard focus restoration on the Sessions list, and the gate that
 * decides whether it happens at all.
 *
 * The design-system suite proves what `GridTableV2` DOES with a resume key, and
 * `use-sessions-focus-restoration.test.tsx` proves when the page-turn restore
 * must not fire and when the remembered row may be consumed. Only this file
 * proves the thing that ships: that `SessionsListSurfaceV2` reads
 * `sessions-focus-restoration` for itself — through the RESOLUTION-AWARE gate,
 * so an assignment that lands after mount still resumes — that the row is
 * recorded by the LINK the reader actually activates and only when that click
 * navigates THIS tab, and that with the key closed the surface behaves exactly
 * as it did before.
 *
 * THREE cases carry a flag-OFF twin on the same fixture, each asserting a
 * DIFFERENT outcome: the page turn, the resume, and the click-recorded resume. A
 * pair that agreed would stay green against a surface that had stopped reading
 * the key at all — which is the failure this gate exists to prevent.
 *
 * The other three have no twin, and that is deliberate rather than missing. Each
 * asserts the ENTRY cell, which is also the flag-off answer, so a twin would
 * assert the same outcome and prove nothing; each is instead pinned by a
 * mutation of its own subject — the grid's staleness guard for the off-page
 * case, `isModifiedClick` for the modifier click, and the readiness half of the
 * gate for the unresolved case, whose own first assertion (entry cell, before
 * the flag answers) is the half that would go green without it.
 */

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  rovingTabStop,
  rowIdOfTabStop,
} from "@repo/design-system/test/grid-roving-tab-stop";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlagAdapter } from "../../../../shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { DEFAULT_DATE_RANGE } from "../../../../shared/lib/format-utils";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../../lib/session-filter-adapter";
import {
  isSessionsListReadPending,
  SessionsListReadState,
} from "../../../lib/sessions-list-read-state";
import {
  createSessionTableRowFixture,
  SESSION_FIXTURE_NOW_MS,
} from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";
import {
  rememberOpenedSessionRow,
  takeOpenedSessionRow,
} from "../use-sessions-focus-restoration";
import { renderWithFlags } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const FIRST_ROW_NAME = "agent/first-row";
const SECOND_ROW_NAME = "agent/second-row";

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({ id: "ses-1", name: FIRST_ROW_NAME }),
  createSessionTableRowFixture({ id: "ses-2", name: SECOND_ROW_NAME }),
];

const BASE_VIEW: SessionsListViewState = {
  sortBy: null,
  sortDir: "asc",
  grouping: EMPTY_TABLE_GROUPING,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  dateRange: DEFAULT_DATE_RANGE,
  visibleColumnIds: new Set(["status"]),
  page: 0,
  scopeUserId: null,
};

const OPEN = [SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY];
const CLOSED: readonly string[] = [];

let restoreContainerWidth: (() => void) | null = null;

function surface(page: number, pageSize: number) {
  return (
    <SessionsListSurfaceV2
      controlledView={{
        value: { ...BASE_VIEW, page },
        onChange: () => undefined,
      }}
      getSessionHref={(row) => `/sessions/${row.id}`}
      pageSize={pageSize}
      rows={ROWS}
      usage={undefined}
    />
  );
}

/** Both rows on one page, so a resumed row is distinguishable from the first. */
function renderWholeList(enabledFlags: readonly string[]) {
  return renderWithFlags(surface(0, ROWS.length), [...enabledFlags]);
}

/** One row per page, so a page turn replaces every cell. */
function renderPaged(enabledFlags: readonly string[]) {
  const result = renderWithFlags(surface(0, 1), [...enabledFlags]);
  return { ...result, turnPage: () => result.rerender(surface(1, 1)) };
}

/**
 * A SERVER-DRIVEN Sessions surface, the shape both hosts drive it in: the host
 * owns the query, reports its read state, and withholds `totalRows` until the
 * read has actually settled (ISS-9554).
 */
function serverDrivenSurface({
  page,
  readState,
  rows,
  totalRows,
}: {
  page: number;
  readState: SessionsListReadState;
  rows: readonly SessionTableRow[];
  totalRows?: number;
}) {
  return (
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => undefined,
        readState,
        value: { ...BASE_VIEW, page },
        ...(totalRows === undefined ? {} : { totalRows }),
      }}
      getSessionHref={(row) => `/sessions/${row.id}`}
      isPending={isSessionsListReadPending(readState)}
      pageSize={ROWS.length}
      rows={rows}
      usage={undefined}
    />
  );
}

/**
 * A gate that answers ENABLED, but only once `resolveFlagEnabled()` is called —
 * the shape of every real web load, where PostHog's assignment lands after the
 * first render. Module state read by a SINGLE adapter object, so the tree keeps
 * one adapter identity across the flip exactly as a real provider does.
 */
let pendingFlagResolved = false;
const PENDING_FLAG_ADAPTER: FeatureFlagAdapter = {
  useFeatureFlagEnabled: (key) =>
    pendingFlagResolved && key === SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY,
  useFeatureFlagResolved: () => pendingFlagResolved,
};

function pendingFlagTree() {
  // A FRESH element each call: React bails out of re-rendering a subtree handed
  // the identical element object, which would hide the flip this drives.
  return (
    <AppCoreStoryProviders>
      <FeatureFlagAdapterProvider adapter={PENDING_FLAG_ADAPTER}>
        {surface(0, ROWS.length)}
      </FeatureFlagAdapterProvider>
    </AppCoreStoryProviders>
  );
}

function renderWithPendingFlag() {
  const result = render(pendingFlagTree());
  return {
    ...result,
    resolveFlagEnabled: () => {
      pendingFlagResolved = true;
      result.rerender(pendingFlagTree());
    },
  };
}

beforeEach(() => {
  // Module state: a case that primed the remembered row would otherwise decide
  // the next one's result.
  takeOpenedSessionRow();
  pendingFlagResolved = false;
  restoreContainerWidth = stubContainerWidthPx(1440);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SESSION_FIXTURE_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("Sessions list focus restoration, page turn", () => {
  it("takes focus back into the grid when the gate is open", () => {
    const { turnPage } = renderPaged(OPEN);
    const leftBehind = rovingTabStop();
    act(() => leftBehind.focus());
    expect(document.activeElement).toBe(leftBehind);

    turnPage();

    expect(screen.getByText(SECOND_ROW_NAME)).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(rovingTabStop());
  });

  it("leaves focus on the document body when the gate is closed", () => {
    const { turnPage } = renderPaged(CLOSED);
    const leftBehind = rovingTabStop();
    act(() => leftBehind.focus());
    expect(document.activeElement).toBe(leftBehind);

    turnPage();

    expect(screen.getByText(SECOND_ROW_NAME)).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("Sessions list focus restoration, returning to the list", () => {
  it("resumes the roving tab stop on the row the reader opened", () => {
    rememberOpenedSessionRow("ses-2");

    renderWholeList(OPEN);

    expect(rowIdOfTabStop()).toBe("ses-2");
  });

  it("leaves the tab stop on the first row when the gate is closed", () => {
    rememberOpenedSessionRow("ses-2");

    renderWholeList(CLOSED);

    expect(rowIdOfTabStop()).toBe("ses-1");
  });

  it("records the row from the link the reader actually activates", () => {
    const { unmount } = renderWholeList(OPEN);
    fireEvent.click(screen.getByText(SECOND_ROW_NAME));
    unmount();

    renderWholeList(OPEN);

    // The write site is the lead cell's `Link`, not a host callback: delete the
    // `onClick` there and this is the case that reddens.
    expect(rowIdOfTabStop()).toBe("ses-2");
  });

  it("does not resume a clicked row when the gate is closed", () => {
    const { unmount } = renderWholeList(CLOSED);
    fireEvent.click(screen.getByText(SECOND_ROW_NAME));
    unmount();

    renderWholeList(CLOSED);

    // The twin of the case above: the WRITE is ungated, so a closed surface
    // still records the row — and must still never act on it.
    expect(rowIdOfTabStop()).toBe("ses-1");
  });

  it("does not record a row from a modifier-click that opens a new tab", () => {
    const { unmount } = renderWholeList(OPEN);
    // Cmd/Ctrl-click opens the session in a NEW tab; THIS list never unmounts
    // for it. `Link` runs the caller's `onClick` before its own modified-click
    // check, so without `isModifiedClick` the row is recorded anyway and
    // resumed on some later, unrelated return to Sessions.
    fireEvent.click(screen.getByText(SECOND_ROW_NAME), { metaKey: true });
    unmount();

    renderWholeList(OPEN);

    expect(rowIdOfTabStop()).toBe("ses-1");
  });

  it("resumes on a flag that only answers after the first render", () => {
    rememberOpenedSessionRow("ses-2");

    const { resolveFlagEnabled } = renderWithPendingFlag();

    // PostHog has not replied. `useFeatureFlagEnabled*` reports `false` here,
    // and a surface that consumed the remembered row against that reading would
    // lose it for the whole visit — the resume can only be read once.
    expect(rowIdOfTabStop()).toBe("ses-1");

    resolveFlagEnabled();

    expect(rowIdOfTabStop()).toBe("ses-2");
  });

  it("keeps the resume when an out-of-range page is clamped onto the reader's row", () => {
    rememberOpenedSessionRow("ses-2");

    // A saved view or a shared URL naming a page the population no longer has.
    // The read is in flight, so there is no total to clamp against and the
    // surface reports the page it was asked for.
    const { rerender } = renderWithFlags(
      serverDrivenSurface({
        page: 5,
        readState: SessionsListReadState.Loading,
        rows: [],
      }),
      [...OPEN]
    );

    // The rows land. NOW the clamp is real, and it corrects page 5 down to the
    // last page that exists — which is the page the reader's row is painted on.
    const settled = {
      readState: SessionsListReadState.Settled,
      rows: ROWS,
      totalRows: ROWS.length,
    };
    rerender(serverDrivenSurface({ ...settled, page: 5 }));
    // The host honours the surface's report-back, as both real hosts do.
    rerender(serverDrivenSurface({ ...settled, page: 0 }));

    // The reader never turned a page: the surface moved its own index twice
    // while settling. Counting either move as a departure spends the resume and
    // leaves the tab stop on `ses-1` — the return this feature exists for, and
    // the one that silently lost it.
    expect(rowIdOfTabStop()).toBe("ses-2");
  });

  it("falls back to the entry cell when the opened row is not on this page", () => {
    rememberOpenedSessionRow("ses-2");

    renderPaged(OPEN);

    // One row per page, so `ses-2` is not painted. The grid's staleness guard
    // still governs: a resume key it does not paint takes the tab stop nowhere.
    expect(screen.queryByText(SECOND_ROW_NAME)).toBeNull();
    expect(rowIdOfTabStop()).toBe("ses-1");
  });
});
