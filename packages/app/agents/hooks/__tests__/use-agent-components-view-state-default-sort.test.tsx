import {
  AgentComponentGroupBy,
  AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import {
  AGENTS_SAVED_VIEW_UNVERSIONED,
  AGENTS_SAVED_VIEW_VERSION,
} from "@repo/app/agents/lib/agents-saved-view-migration";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useAgentComponentsViewState } from "../use-agent-components-view-state";

/**
 * ISS-5005, at the restore boundary: the Agents catalog lands on a usage-bearing
 * default sort, and a persisted view still carrying the untouched alphabetical
 * default is promoted ONCE — only when the flag is on, and written back so the
 * next load does not redo it.
 *
 * Why the boundary and not just the default: `usePersistedTableViewState` writes
 * the resolved view to `localStorage` as soon as its restore effect commits,
 * including when it committed nothing but defaults. Every user who has ever
 * opened the Agents page therefore already has `name`/`asc` stored, and a
 * default-only change would be handed straight back to them forever. These cases
 * pin the stored-view path, which is the one real users are on.
 */

const PERSIST_KEY = "agents:test";
// The saved view is namespaced by the authenticated user (FEA-4168), and
// `AppCoreStoryProviders` mounts the static auth adapter's `user_test`. Seeding
// and reading the SAME per-user key keeps these focused on the migration rather
// than incidentally exercising the legacy un-namespaced restore fallback.
const STORAGE_KEY = `agents:saved-view:${PERSIST_KEY}:u:user_test`;

function seedSavedView(
  sort: { sortKey: AgentComponentSortKey; sortDir: AgentComponentSortDir },
  version?: number
) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      columnOrder: [],
      groupBy: AgentComponentGroupBy.None,
      hiddenColumns: [],
      metricMode: AgentMetricMode.LocPerDollar,
      sortDir: sort.sortDir,
      sortKey: sort.sortKey,
      ...(version === undefined ? {} : { savedViewVersion: version }),
    })
  );
}

function seedSavedViewRaw(fields: Record<string, unknown>) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      columnOrder: [],
      groupBy: AgentComponentGroupBy.None,
      hiddenColumns: [],
      metricMode: AgentMetricMode.LocPerDollar,
      ...fields,
    })
  );
}

function readSavedView(): {
  sortKey?: string;
  sortDir?: string;
  hiddenColumns?: string[];
  columnOrder?: string[];
  groupBy?: string;
  metricMode?: string;
  savedViewVersion?: number;
} {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
}

const LEGACY_STORED_SORT = {
  sortDir: AgentComponentSortDir.Asc,
  sortKey: AgentComponentSortKey.Name,
};

function withFlag(enabled: boolean) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders
      enabledFlags={enabled ? [AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY] : []}
    >
      {children}
    </AppCoreStoryProviders>
  );
}

afterEach(() => {
  localStorage.clear();
});

describe("useAgentComponentsViewState usage-first default sort (ISS-5005)", () => {
  it("flag OFF: a fresh view still opens on Component ascending", async () => {
    const { result } = renderHook(() => useAgentComponentsViewState(), {
      wrapper: withFlag(false),
    });

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Name)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
  });

  it("flag ON: a fresh view opens on the most-invoked components", async () => {
    const { result } = renderHook(() => useAgentComponentsViewState(), {
      wrapper: withFlag(true),
    });

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Invocations)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Desc);
  });

  it("flag OFF: restores a stored legacy sort verbatim and never stamps it", async () => {
    seedSavedView(LEGACY_STORED_SORT);

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(false) }
    );

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Name)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
    // Left unstamped, so a later flag flip can still promote it. Stamping here
    // would strand a dark-launch user on the alphabetical default forever.
    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(
        AGENTS_SAVED_VIEW_UNVERSIONED
      )
    );
    expect(readSavedView().sortKey).toBe(AgentComponentSortKey.Name);
  });

  // The precise closed-by-default claim: the dark path rewrites no view
  // DIMENSION. It is not a byte-identical storage claim — the shared persist
  // effect re-serializes the whole view on mount and now carries an inert
  // `savedViewVersion: 0` marker, asserted above. This pins the part that is
  // actually a behavioral contract.
  it("flag OFF: restores every view dimension of a non-default stored view verbatim", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnOrder: ["metric", "type"],
        groupBy: AgentComponentGroupBy.Harness,
        hiddenColumns: ["harness"],
        metricMode: AgentMetricMode.ValueIndex,
        sortDir: AgentComponentSortDir.Asc,
        sortKey: AgentComponentSortKey.Name,
      })
    );

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(false) }
    );

    await waitFor(() =>
      expect(result.current.groupBy).toBe(AgentComponentGroupBy.Harness)
    );
    expect(result.current.sortKey).toBe(AgentComponentSortKey.Name);
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
    expect(result.current.metricMode).toBe(AgentMetricMode.ValueIndex);
    expect(result.current.visibleColumns.has("harness")).toBe(false);
    expect(result.current.columnOrder).toEqual(["metric", "type"]);
    // And the persisted copy still carries the same dimensions.
    await waitFor(() =>
      expect(readSavedView().sortKey).toBe(AgentComponentSortKey.Name)
    );
    expect(readSavedView().groupBy).toBe(AgentComponentGroupBy.Harness);
    expect(readSavedView().metricMode).toBe(AgentMetricMode.ValueIndex);
    expect(readSavedView().hiddenColumns).toEqual(["harness"]);
    expect(readSavedView().columnOrder).toEqual(["metric", "type"]);
  });

  it("flag ON: promotes a stored legacy sort to Invocations descending", async () => {
    seedSavedView(LEGACY_STORED_SORT);

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(true) }
    );

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Invocations)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Desc);
  });

  it("flag ON: touches only the sort — grouping, metric mode, hidden columns, and order survive", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnOrder: ["metric", "type"],
        groupBy: AgentComponentGroupBy.Harness,
        hiddenColumns: ["harness"],
        metricMode: AgentMetricMode.ValueIndex,
        sortDir: AgentComponentSortDir.Asc,
        sortKey: AgentComponentSortKey.Name,
      })
    );

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(true) }
    );

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Invocations)
    );
    // Bumping the storage key prefix would have been one line and would have
    // taken all of these with it. Nothing here is collateral.
    expect(result.current.groupBy).toBe(AgentComponentGroupBy.Harness);
    expect(result.current.metricMode).toBe(AgentMetricMode.ValueIndex);
    expect(result.current.visibleColumns.has("harness")).toBe(false);
    expect(result.current.columnOrder).toEqual(["metric", "type"]);
  });

  it("flag ON: persists the promoted sort AND its version, so the next load is a no-op", async () => {
    seedSavedView(LEGACY_STORED_SORT);

    renderHook(() => useAgentComponentsViewState(PERSIST_KEY), {
      wrapper: withFlag(true),
    });

    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(AGENTS_SAVED_VIEW_VERSION)
    );
    expect(readSavedView().sortKey).toBe(AgentComponentSortKey.Invocations);
    expect(readSavedView().sortDir).toBe(AgentComponentSortDir.Desc);
  });

  it("flag ON: leaves a user-chosen sort alone", async () => {
    const userChoice = {
      sortDir: AgentComponentSortDir.Desc,
      sortKey: AgentComponentSortKey.Sessions,
    };
    seedSavedView(userChoice);

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(true) }
    );

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Sessions)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Desc);
  });

  it("flag ON: does not fight a user who sorted back to Component ascending after migrating", async () => {
    seedSavedView(LEGACY_STORED_SORT, AGENTS_SAVED_VIEW_VERSION);

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(true) }
    );

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Name)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
  });

  it("flag ON: malformed savedViewVersion degrades to unversioned and migrates without dropping other dimensions", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnOrder: ["metric", "type"],
        groupBy: AgentComponentGroupBy.Harness,
        hiddenColumns: ["harness"],
        metricMode: AgentMetricMode.ValueIndex,
        sortDir: AgentComponentSortDir.Asc,
        sortKey: AgentComponentSortKey.Name,
        savedViewVersion: "not-a-number",
      })
    );

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(true) }
    );

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Invocations)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Desc);
    expect(result.current.groupBy).toBe(AgentComponentGroupBy.Harness);
    expect(result.current.metricMode).toBe(AgentMetricMode.ValueIndex);
    expect(result.current.visibleColumns.has("harness")).toBe(false);
    expect(result.current.columnOrder).toEqual(["metric", "type"]);
    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(AGENTS_SAVED_VIEW_VERSION)
    );
  });

  it("flag ON: negative savedViewVersion degrades to unversioned and migrates", async () => {
    seedSavedViewRaw({
      sortDir: AgentComponentSortDir.Asc,
      sortKey: AgentComponentSortKey.Name,
      savedViewVersion: -1,
    });

    const { result } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withFlag(true) }
    );

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Invocations)
    );
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Desc);
  });
});

/**
 * The gate does not always resolve before the restore runs. Desktop starts every
 * Labs key at `false` and hydrates it asynchronously while the catalog stays
 * mounted, and PostHog resolves after mount on web — so if the restore only ever
 * ran for the first parser it saw, the promotion would be skipped on every single
 * launch that lost that race.
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

describe("useAgentComponentsViewState usage-first default sort, late gate (ISS-5005)", () => {
  afterEach(() => {
    lateEnabledFlags.clear();
  });

  it("promotes when the flag resolves AFTER the restore, not on the next load", async () => {
    seedSavedView(LEGACY_STORED_SORT);

    const { result, rerender } = renderHook(
      () => useAgentComponentsViewState(PERSIST_KEY),
      { wrapper: withLateFlag }
    );

    // The race this reproduces: restore wins, so the stored alphabetical sort is
    // live and unpromoted. Asserting it first is what makes the flip meaningful.
    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Name)
    );

    lateEnabledFlags.add(AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY);
    rerender();

    await waitFor(() =>
      expect(result.current.sortKey).toBe(AgentComponentSortKey.Invocations)
    );
    await waitFor(() =>
      expect(readSavedView().savedViewVersion).toBe(AGENTS_SAVED_VIEW_VERSION)
    );
  });
});
