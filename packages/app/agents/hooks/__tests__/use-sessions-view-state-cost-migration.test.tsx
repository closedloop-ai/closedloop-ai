import {
  SESSIONS_SAVED_VIEW_UNVERSIONED,
  SESSIONS_SAVED_VIEW_VERSION,
} from "@repo/app/agents/lib/sessions-saved-view-migration";
import { SESSIONS_COST_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionSortDir } from "../../lib/session-sort-group";
import { useSessionsViewState } from "../use-sessions-view-state";

/**
 * ISS-4890, at the restore boundary: a persisted saved view whose `columnOrder`
 * still holds Cost past the fold is repaired ONCE, only when the flag is on, and
 * the repair is written back so the next load does not redo it.
 *
 * The fixture is a real pre-ISS-4788 arrangement (Cost 6th, after PR). With the
 * flag OFF the stored order must come back byte-for-byte — that is the
 * closed-by-default guarantee, and it means the flag-on assertions below cannot
 * pass merely because the default happens to agree.
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

function withFlag(enabled: boolean) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders
      enabledFlags={
        enabled ? [SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY] : []
      }
    >
      {children}
    </AppCoreStoryProviders>
  );
}

afterEach(() => {
  localStorage.clear();
});

describe("useSessionsViewState Cost relocation (ISS-4890)", () => {
  it("flag OFF: restores an unmigrated order verbatim and never stamps it", async () => {
    seedSavedView(COST_LATE_ORDER);

    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: withFlag(false),
    });

    await waitFor(() =>
      expect(result.current.columnOrder).toEqual(COST_LATE_ORDER)
    );
    // Cost is still 6th — the closed-by-default state. If this ever passes
    // because the fixture matched the default, the flag-on case below is void.
    expect(result.current.columnOrder.indexOf(SESSIONS_COST_COLUMN_ID)).toBe(5);
    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(
        SESSIONS_SAVED_VIEW_UNVERSIONED
      )
    );
    expect(readSavedView().columnOrder).toEqual(COST_LATE_ORDER);
  });

  it("flag ON: relocates Cost in front of the fold and leaves the rest of the arrangement alone", async () => {
    seedSavedView(COST_LATE_ORDER);

    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: withFlag(true),
    });

    await waitFor(() =>
      expect(result.current.columnOrder).toEqual([
        "owner",
        "status",
        SESSIONS_COST_COLUMN_ID,
        "repo",
        "branches",
        "pr",
        "started",
      ])
    );
  });

  it("flag ON: touches only the column order — sort, hidden columns, and the window survive", async () => {
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
      wrapper: withFlag(true),
    });

    await waitFor(() =>
      expect(result.current.columnOrder.indexOf(SESSIONS_COST_COLUMN_ID)).toBe(
        2
      )
    );
    // Bumping the storage key prefix would have been one line and would have
    // taken all of these with it. Nothing here is collateral.
    expect(result.current.sortDir).toBe(SessionSortDir.Asc);
    expect(result.current.dateRange).toBe("90d");
    expect(result.current.visibleColumns.has("merge")).toBe(false);
  });

  it("flag ON: persists the migrated order AND its version, so the next load is a no-op", async () => {
    seedSavedView(COST_LATE_ORDER);

    renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: withFlag(true),
    });

    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(SESSIONS_SAVED_VIEW_VERSION)
    );
    expect(readSavedView().columnOrder?.indexOf(SESSIONS_COST_COLUMN_ID)).toBe(
      2
    );
  });

  it("flag ON: does not fight a user who deliberately moved Cost back after migrating", async () => {
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
      wrapper: withFlag(true),
    });

    await waitFor(() => expect(result.current.columnOrder).toEqual(userChoice));
  });
});

/**
 * ISS-4890 (wongk cid 3700596172): the gate does not always resolve before the
 * restore runs. Desktop starts every Labs key at `false` and hydrates it
 * asynchronously while Sessions stays mounted, and PostHog resolves after mount
 * on web — so if the restore only ever ran for the first parser it saw, the
 * migration would be skipped on every single launch that lost that race.
 *
 * The adapter here reads a MUTABLE set so the flag can flip false→true while the
 * hook stays mounted, which the story providers' snapshot adapter cannot do.
 */
const lateEnabledFlags = new Set<string>();

const lateFlagAdapter: FeatureFlagAdapter = {
  useFeatureFlagEnabled: (key: string) => lateEnabledFlags.has(key),
};

function withLateFlag({ children }: { children: ReactNode }) {
  return (
    <AppCoreStoryProviders>
      <FeatureFlagAdapterProvider adapter={lateFlagAdapter}>
        {children}
      </FeatureFlagAdapterProvider>
    </AppCoreStoryProviders>
  );
}

describe("useSessionsViewState Cost relocation, late gate (ISS-4890)", () => {
  afterEach(() => {
    lateEnabledFlags.clear();
  });

  it("applies the migration when the flag resolves AFTER the restore, not on the next load", async () => {
    seedSavedView(COST_LATE_ORDER);

    const { result, rerender } = renderHook(
      () => useSessionsViewState(PERSIST_KEY),
      { wrapper: withLateFlag }
    );

    // The race this reproduces: restore wins, so the stored order is live and
    // unmigrated. Asserting it first is what makes the flip below meaningful.
    await waitFor(() =>
      expect(result.current.columnOrder).toEqual(COST_LATE_ORDER)
    );

    lateEnabledFlags.add(SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY);
    rerender();

    await waitFor(() =>
      expect(result.current.columnOrder.indexOf(SESSIONS_COST_COLUMN_ID)).toBe(
        2
      )
    );
    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(SESSIONS_SAVED_VIEW_VERSION)
    );
  });
});
