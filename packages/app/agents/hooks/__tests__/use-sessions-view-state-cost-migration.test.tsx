import { SESSIONS_SAVED_VIEW_VERSION } from "@repo/app/agents/lib/sessions-saved-view-migration";
import { SESSIONS_COST_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionSortDir } from "../../lib/session-sort-group";
import { useSessionsViewState } from "../use-sessions-view-state";

/**
 * ISS-4890, at the restore boundary: a persisted saved view whose `columnOrder`
 * still holds Cost past the fold is repaired ONCE, and the repair is written
 * back so the next load does not redo it.
 *
 * The fixture is a real pre-ISS-4788 arrangement (Cost 6th, after PR), so the
 * assertions cannot pass merely because the default happens to agree.
 *
 * ISS-10636 moved the destination from slot 2 to slot 1, because the budget is
 * arithmetic over the track the table DRAWS and that track went from 124px to
 * 168px for the one dollar phrase. At 168 the Cost column placed after `status`
 * ends at 780px against a 768px budget — 12px past the fold — so slot 1 is the
 * last one that fits. Slot 2 was not a weaker answer being loosened here; it was
 * the answer to the old width (tamsinb review, PR #7560).
 */

const PERSIST_KEY = "sessions:test";
// The saved view is namespaced by the authenticated user (FEA-4168), and
// `AppCoreStoryProviders` mounts the static auth adapter's `user_test`. Seeding
// and reading the SAME per-user key keeps these focused on the migration rather
// than incidentally exercising the legacy un-namespaced restore fallback.
const STORAGE_KEY = `sessions:saved-view:${PERSIST_KEY}:u:user_test`;
const COST_LATE_ORDER = [
  "owner",
  "status",
  "repo",
  "branches",
  "pr",
  SESSIONS_COST_COLUMN_ID,
  "started",
];

function seedSavedView(columnOrder: readonly string[], version?: number) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      sortKey: null,
      sortDir: SessionSortDir.Desc,
      hiddenColumns: [],
      columnOrder,
      dateRange: "30d",
      ...(version === undefined ? {} : { savedViewVersion: version }),
    })
  );
}

function readSavedView(): {
  columnOrder?: string[];
  hiddenColumns?: string[];
  dateRange?: string;
  sortDir?: string;
  savedViewVersion?: number;
} {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
}

function withProviders({ children }: { children: ReactNode }) {
  return <AppCoreStoryProviders>{children}</AppCoreStoryProviders>;
}

afterEach(() => {
  localStorage.clear();
});

describe("useSessionsViewState Cost relocation (ISS-4890)", () => {
  it("relocates Cost in front of the fold and leaves the rest of the arrangement alone", async () => {
    seedSavedView(COST_LATE_ORDER);

    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: withProviders,
    });

    await waitFor(() =>
      expect(result.current.columnOrder).toEqual([
        "owner",
        SESSIONS_COST_COLUMN_ID,
        "status",
        "repo",
        "branches",
        "pr",
        "started",
      ])
    );
  });

  it("touches only the column order — sort, hidden columns, and the window survive", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortKey: null,
        sortDir: SessionSortDir.Asc,
        hiddenColumns: ["merge"],
        columnOrder: COST_LATE_ORDER,
        dateRange: "90d",
      })
    );

    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: withProviders,
    });

    await waitFor(() =>
      expect(result.current.columnOrder.indexOf(SESSIONS_COST_COLUMN_ID)).toBe(
        1
      )
    );
    // Bumping the storage key prefix would have been one line and would have
    // taken all of these with it. Nothing here is collateral.
    expect(result.current.sortDir).toBe(SessionSortDir.Asc);
    expect(result.current.dateRange).toBe("90d");
    expect(result.current.visibleColumns.has("merge")).toBe(false);
  });

  it("persists the migrated order AND its version, so the next load is a no-op", async () => {
    seedSavedView(COST_LATE_ORDER);

    renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: withProviders,
    });

    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(SESSIONS_SAVED_VIEW_VERSION)
    );
    expect(readSavedView().columnOrder?.indexOf(SESSIONS_COST_COLUMN_ID)).toBe(
      1
    );
  });

  it("does not fight a user who deliberately moved Cost back after migrating", async () => {
    // Already stamped at the current version, with Cost dragged to the end.
    const userChoice = [
      "owner",
      "status",
      "repo",
      "pr",
      SESSIONS_COST_COLUMN_ID,
    ];
    seedSavedView(userChoice, SESSIONS_SAVED_VIEW_VERSION);

    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: withProviders,
    });

    await waitFor(() => expect(result.current.columnOrder).toEqual(userChoice));
  });
});
