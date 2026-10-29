import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderSessionsListBody } from "../sessions-list-body-v2";
import { SESSIONS_LIST_LOADING_LABEL } from "../sessions-list-loading-labels";

/**
 * ISS-9105 / ISS-9106 (Bug Hunter B, code review) — a pending or clamped read
 * still outranks the rows this surface is HOLDING.
 *
 * Routing the pending state through the shared `renderSessionsListLoading`
 * resolver gated it on `!hasData`, because that is what the desktop v1 body
 * wants. This surface does not: `isAwaitingClampedPage` fires precisely when a
 * narrowed filter shrank the page count while `keepPreviousData` is still
 * showing the PREVIOUS page's rows — rows that need not match the filter the
 * reader just applied. Falling through to them renders a list that contradicts
 * the filter bar above it.
 *
 * A host supplying no loading copy (every web Sessions host today) is the case
 * that regressed, so it is the case pinned here.
 *
 * An empty placeholder frame is a pending read too (ISS-9907): its rows belong
 * to a read that has not landed, so it is never an answer about the filters.
 */

const SKELETON_TEST_ID = "sessions-list-skeleton";
const GENUINE_EMPTY_TITLE = "No sessions yet";

function renderBody(
  overrides: Partial<Parameters<typeof renderSessionsListBody>[0]>
) {
  return render(
    <div>
      {renderSessionsListBody({
        filtersActive: false,
        hasConnectedAgent: true,
        isAwaitingClampedPage: false,
        isError: false,
        isPending: false,
        isPlaceholderPage: false,
        isSyncing: false,
        listNarrowed: false,
        onClearFilters: () => {
          // not under test
        },
        onShowAllTime: () => {
          // not under test
        },
        rowCount: 0,
        showAllTimeOffered: false,
        stallPhase: "none",
        ...overrides,
      })}
    </div>
  );
}

describe("renderSessionsListBody pending precedence", () => {
  it("covers held rows with the skeleton while a clamped page loads", () => {
    renderBody({ isAwaitingClampedPage: true, rowCount: 25 });

    expect(screen.getByTestId(SKELETON_TEST_ID)).not.toBeNull();
  });

  it("covers held rows with the skeleton while a pending read is in flight", () => {
    renderBody({ isPending: true, rowCount: 25 });

    expect(screen.getByTestId(SKELETON_TEST_ID)).not.toBeNull();
  });

  // The positive sibling: the precedence must not swallow a settled page, or
  // the surface would skeleton forever instead of rendering its rows.
  it("yields to the rows once the read has settled", () => {
    renderBody({ rowCount: 25 });

    expect(screen.queryByTestId(SKELETON_TEST_ID)).toBeNull();
    expect(screen.queryByText(GENUINE_EMPTY_TITLE)).toBeNull();
  });

  it("still reaches the honest empty state on a settled zero-row read", () => {
    renderBody({});

    expect(screen.getByText(GENUINE_EMPTY_TITLE)).not.toBeNull();
    expect(screen.queryByTestId(SKELETON_TEST_ID)).toBeNull();
  });

  it("covers an empty placeholder frame with the skeleton, not the empty state", () => {
    renderBody({ isPlaceholderPage: true });

    expect(screen.getByTestId(SKELETON_TEST_ID)).not.toBeNull();
    expect(screen.queryByText(GENUINE_EMPTY_TITLE)).toBeNull();
  });

  // A page turn under `keepPreviousData` is a placeholder frame WITH rows, and
  // those rows stay on screen until the new page lands.
  it("keeps the rows a placeholder frame is holding", () => {
    renderBody({ isPlaceholderPage: true, rowCount: 25 });

    expect(screen.queryByTestId(SKELETON_TEST_ID)).toBeNull();
    expect(screen.queryByText(GENUINE_EMPTY_TITLE)).toBeNull();
  });

  // A host with loading copy says what the read is doing instead of showing the
  // skeleton. Pinned with no stall escalation: desktop does pass `onRetry`, but
  // its stall detector arms only on a pending read and a placeholder read is
  // never pending, so `stallPhase` stays "none" on this frame.
  it("shows the host's loading copy over an empty placeholder frame", () => {
    renderBody({
      isPlaceholderPage: true,
      loadingLabel: SESSIONS_LIST_LOADING_LABEL,
    });

    expect(screen.getByRole("status").textContent).toContain(
      SESSIONS_LIST_LOADING_LABEL
    );
    expect(screen.queryByTestId(SKELETON_TEST_ID)).toBeNull();
    expect(screen.queryByText(GENUINE_EMPTY_TITLE)).toBeNull();
  });

  // A loading-copy host's page turn: the resolver returns that copy whenever
  // the host supplies it, whatever `isLoading` says, so the placeholder flag
  // must leave this frame exactly as it was.
  it("leaves a loading-copy host's held-rows frame unchanged by the placeholder flag", () => {
    const withoutFlag = renderBody({
      loadingLabel: SESSIONS_LIST_LOADING_LABEL,
      rowCount: 25,
    }).container.innerHTML;
    const withFlag = renderBody({
      isPlaceholderPage: true,
      loadingLabel: SESSIONS_LIST_LOADING_LABEL,
      rowCount: 25,
    }).container.innerHTML;

    expect(withFlag).toBe(withoutFlag);
    expect(withFlag).toContain(SESSIONS_LIST_LOADING_LABEL);
  });
});
