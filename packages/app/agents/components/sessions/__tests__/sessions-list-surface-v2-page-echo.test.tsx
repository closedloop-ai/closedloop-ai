import {
  AgentSessionListCapability,
  type AgentSessionListPageInfo,
} from "@repo/api/src/types/agent-session-list-contract";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-9555 slice 3 — the rendered page position comes from the producer's echo,
 * not from the surface re-deriving it.
 *
 * The fixture below is the case that separates the two: the producer served page
 * 2 while `totalRows` says page 12 exists. That is not contrived — it is what a
 * producer serving a page the client did not compute looks like from the client,
 * and client arithmetic has nothing to notice it with: 12 is a perfectly valid
 * page of 300 rows, so the surface leaves the reader on a footer that names a
 * page the rows are not from.
 */

const PAGE_SIZE = 10;

const SERVED_PAGE = 2;

const REQUESTED_PAGE = 12;

/** Enough rows that page 12 is real by the client's own arithmetic. */
const DEEP_TOTAL = 300;

const SERVED_ECHO: AgentSessionListPageInfo = {
  capability: AgentSessionListCapability.ServerPaginationV1,
  limit: PAGE_SIZE,
  offset: SERVED_PAGE * PAGE_SIZE,
};

function baseView(
  overrides: Partial<SessionsListViewState> = {}
): SessionsListViewState {
  return {
    sortBy: null,
    sortDir: "asc",
    grouping: EMPTY_TABLE_GROUPING,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    dateRange: DEFAULT_DATE_RANGE,
    visibleColumnIds: new Set(["status"]),
    page: REQUESTED_PAGE,
    scopeUserId: null,
    ...overrides,
  };
}

function serverRows(from: number, count: number): readonly SessionTableRow[] {
  return Array.from({ length: count }, (_, index) =>
    createSessionTableRowFixture({
      id: `ses-${from + index}`,
      name: `agent/row-${from + index}`,
    })
  );
}

/**
 * A host that owns the query: it holds the page, hands the surface the rows the
 * producer returned, and records every read it would have issued.
 */
function EchoHost({
  applyReportedPage = true,
  initialView,
  isError = false,
  isPlaceholderPage = false,
  onRead,
  pageInfo,
  totalRows,
}: {
  /**
   * Whether the host applies the page the surface reports back. `false` holds
   * the surface on the frame BEFORE its own correction settles, which is the
   * only frame in which the footer can contradict the rows it is over.
   */
  applyReportedPage?: boolean;
  initialView: SessionsListViewState;
  isError?: boolean;
  isPlaceholderPage?: boolean;
  onRead: (offset: number) => void;
  pageInfo?: AgentSessionListPageInfo;
  totalRows: number;
}) {
  const [view, setView] = useState(initialView);
  return (
    <SessionsListSurfaceV2
      controlledView={{
        onChange: (next) => {
          if (applyReportedPage) {
            setView(next);
          }
          onRead(next.page * PAGE_SIZE);
        },
        totalRows,
        value: view,
      }}
      isError={isError}
      isPlaceholderPage={isPlaceholderPage}
      pageInfo={pageInfo}
      pageSize={PAGE_SIZE}
      rows={serverRows(SERVED_PAGE * PAGE_SIZE + 1, PAGE_SIZE)}
      usage={undefined}
    />
  );
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 page echo (ISS-9555)", () => {
  it("states the page the producer served, not the one the host asked for", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(
      <EchoHost
        initialView={baseView()}
        onRead={onRead}
        pageInfo={SERVED_ECHO}
        totalRows={DEEP_TOTAL}
      />
    );

    // The position reported back is the SERVED one. Derived from the request and
    // `totalRows` instead, page 12 is in range and nothing is reported at all —
    // which is the reader left on a footer that disagrees with its own rows.
    expect(onRead).toHaveBeenCalledWith(SERVED_PAGE * PAGE_SIZE);
    expect(
      screen.getByText(`Showing 21-30 of ${DEEP_TOTAL} sessions`)
    ).toBeInTheDocument();
  });

  it("states the served page on the frame before its own correction settles", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(
      // The host does NOT apply the reported page, so the surface stays on the
      // one frame where `view.page` is still 12 and the rows are the producer's
      // page 2. Reading the position off the request there says "Showing
      // 121-130 of 300" over session ids 21-30 — the footer contradicting the
      // rows it is under, which is what slice 3 exists to end.
      <EchoHost
        applyReportedPage={false}
        initialView={baseView()}
        onRead={onRead}
        pageInfo={SERVED_ECHO}
        totalRows={DEEP_TOTAL}
      />
    );

    expect(onRead).toHaveBeenCalledWith(SERVED_PAGE * PAGE_SIZE);
    expect(
      screen.getByText(`Showing 21-30 of ${DEEP_TOTAL} sessions`)
    ).toBeInTheDocument();
  });

  it("ignores the previous page's echo while its rows are held as a placeholder", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(
      // A page turn under `keepPreviousData`: the view already names the page
      // the reader clicked, while the rows AND the echo still describe the page
      // they left. Adopting that echo reports the old page back to the host,
      // which snaps the reader to the page they just turned away from.
      <EchoHost
        initialView={baseView({ page: SERVED_PAGE + 1 })}
        isPlaceholderPage
        onRead={onRead}
        pageInfo={SERVED_ECHO}
        totalRows={DEEP_TOTAL}
      />
    );

    expect(onRead).not.toHaveBeenCalled();
  });

  it("maps retained placeholder rows to the mastered loading state", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = renderMasteredEchoHost({
      initialView: baseView(),
      isPlaceholderPage: true,
    });

    expect(contractWrapper(container)).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Loading
    );
    expect(contractWrapper(container)).toHaveAttribute("aria-busy", "true");
  });

  it("maps retained failed-read rows to the mastered error state", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = renderMasteredEchoHost({
      initialView: baseView(),
      isError: true,
    });

    expect(contractWrapper(container)).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Error
    );
    expect(contractWrapper(container)).not.toHaveAttribute("aria-invalid");
  });

  it("derives in place when the producer sent no echo, and asks for nothing more", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(
      <EchoHost
        initialView={baseView()}
        onRead={onRead}
        totalRows={DEEP_TOTAL}
      />
    );

    // Byte-identical to before the echo existed: page 12 is in range for 300
    // rows, so the surface reports nothing. And it does NOT go looking for an
    // echo — Sessions has no unpaginated mode to re-read, so Branches' legacy
    // fallback would be a second request that learns nothing.
    expect(onRead).not.toHaveBeenCalled();
    expect(
      screen.getByText(`Showing 121-130 of ${DEEP_TOTAL} sessions`)
    ).toBeInTheDocument();
  });

  it("keeps the client repair for an out-of-range page with no echo", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(
      <EchoHost initialView={baseView()} onRead={onRead} totalRows={25} />
    );

    // 25 rows over pages of 10 is three pages, so the last valid index is 2 —
    // the derivation the absent-echo path must keep, unchanged.
    expect(onRead).toHaveBeenCalledWith(20);
  });

  it("falls back to the derivation when the echo cannot name a page", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(
      <EchoHost
        initialView={baseView()}
        onRead={onRead}
        // Not a multiple of the limit, so it names a row rather than a page. A
        // fractional page index is worse than the derivation it would replace.
        pageInfo={{ ...SERVED_ECHO, offset: 23 }}
        totalRows={25}
      />
    );

    expect(onRead).toHaveBeenCalledWith(20);
  });

  it("falls back when the producer paged in a size the reader is not paging in", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(
      <EchoHost
        initialView={baseView()}
        onRead={onRead}
        // The desktop local read clamps a limit to its own ceiling rather than
        // rejecting it, so the honoured limit can be one the reader never asked
        // for. `offset / limit` is then a page index in the producer's units,
        // and 50 is not where these rows are.
        pageInfo={{ ...SERVED_ECHO, limit: 2, offset: 100 }}
        totalRows={25}
      />
    );

    expect(onRead).toHaveBeenCalledWith(20);
  });

  it("holds the skeleton, not the empty state, while an out-of-range page is corrected", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onRead = vi.fn();
    render(<CorrectionHost onRead={onRead} />);

    // ISS-9907: the correction fired, so the render has moved past the settled
    // out-of-range frame onto the placeholder frame that used to flash empty.
    expect(onRead).toHaveBeenCalledWith(CORRECTED_PAGE * PAGE_SIZE);
    expect(screen.getByTestId(SKELETON_TEST_ID)).toBeInTheDocument();
    for (const title of SETTLED_EMPTY_TITLES) {
      expect(screen.queryByText(title)).toBeNull();
    }
  });
});

const SKELETON_TEST_ID = "sessions-list-skeleton";

/** Every title `SessionsEmptyState` can give a readable list that settled empty. */
const SETTLED_EMPTY_TITLES = [
  "No sessions yet",
  "No matching sessions",
  "No sessions synced yet",
];

const OUT_OF_RANGE_PAGE = 10;

/** Three pages at `PAGE_SIZE`, so page 10 is out of range. */
const SHRUNK_TOTAL = 30;

const CORRECTED_PAGE = 2;

const OUT_OF_RANGE_ECHO: AgentSessionListPageInfo = {
  capability: AgentSessionListCapability.ServerPaginationV1,
  limit: PAGE_SIZE,
  offset: OUT_OF_RANGE_PAGE * PAGE_SIZE,
};

const NO_ROWS: readonly SessionTableRow[] = [];

/**
 * A host simulating `keepPreviousData` over one settled read. The first frame
 * is that read: empty, echoing the out-of-range page, with a known total. Once
 * the surface reports the corrected page, the new query key has not landed, so
 * the same empty result is held as a placeholder and — as the web host does —
 * the total it no longer knows is withheld.
 */
function CorrectionHost({ onRead }: { onRead: (offset: number) => void }) {
  const [view, setView] = useState(() => baseView({ page: OUT_OF_RANGE_PAGE }));
  const isSettledFrame = view.page === OUT_OF_RANGE_PAGE;
  return (
    <SessionsListSurfaceV2
      controlledView={{
        onChange: (next) => {
          setView(next);
          onRead(next.page * PAGE_SIZE);
        },
        readState: isSettledFrame
          ? SessionsListReadState.Settled
          : SessionsListReadState.Placeholder,
        ...(isSettledFrame ? { totalRows: SHRUNK_TOTAL } : {}),
        value: view,
      }}
      isPlaceholderPage={!isSettledFrame}
      pageInfo={OUT_OF_RANGE_ECHO}
      pageSize={PAGE_SIZE}
      rows={NO_ROWS}
      usage={undefined}
    />
  );
}

function renderMasteredEchoHost({
  initialView,
  isError = false,
  isPlaceholderPage = false,
}: {
  initialView: SessionsListViewState;
  isError?: boolean;
  isPlaceholderPage?: boolean;
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      })}
    >
      <EchoHost
        initialView={initialView}
        isError={isError}
        isPlaceholderPage={isPlaceholderPage}
        onRead={() => undefined}
        totalRows={DEEP_TOTAL}
      />
    </FeatureFlagAdapterProvider>
  );
}

function contractWrapper(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>(
    '[data-grid-interaction-contract="pointer-hover"]'
  );
  if (!wrapper) {
    throw new Error("pointer interaction contract is not rendered");
  }
  return wrapper;
}
