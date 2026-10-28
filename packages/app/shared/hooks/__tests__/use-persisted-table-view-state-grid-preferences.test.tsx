import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceReadStatus,
  GridPreferenceScopeKey,
  GridPreferenceWriteStatus,
} from "@repo/api/src/types/grid-preferences";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiAdapter } from "../../api/api-adapter";
import { ApiAdapterProvider } from "../../api/provider";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import {
  GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY,
  ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY,
} from "../../lib/feature-flags";
import { GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS } from "../use-grid-preference-remote";
import { usePersistedTableViewState } from "../use-persisted-table-view-state";
import {
  COLUMN_IDS,
  type ColumnId,
  type Extras,
  parse,
  type SortDir,
  type SortKey,
} from "./persisted-table-view-state.test-support";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: () => undefined, info: () => undefined },
}));

const USER_ID = "user-1";
const STORAGE_KEY = `test:view:web:u:${USER_ID}`;

type Call = { method: string; body: unknown };

function preferenceRow(value: Record<string, unknown>, revision: number) {
  return {
    contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    createdAt: "2026-09-11T00:00:00.000Z",
    gridKey: GridPreferenceGridKey.Sessions,
    preferenceKind: GridPreferenceKind.ViewState,
    revision,
    scopeKey: GridPreferenceScopeKey.Default,
    updatedAt: "2026-09-11T00:00:00.000Z",
    value,
  };
}

/**
 * A transport whose GET serves whatever the test seeded as the account's row and
 * whose POST is scripted per case. The real `useApiClientOptional` runs on top,
 * so the assertions below are about the production request path.
 */
function createTransport(options: {
  serverValue: Record<string, unknown> | null;
  serverRevision?: number;
  writeStatus?: number;
}) {
  const calls: Call[] = [];
  const adapter: ApiAdapter = {
    fetch: (_input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
      });
      if (method === "GET") {
        const data =
          options.serverValue === null
            ? {
                contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
                selector: {
                  gridKey: GridPreferenceGridKey.Sessions,
                  preferenceKind: GridPreferenceKind.ViewState,
                  scopeKey: GridPreferenceScopeKey.Default,
                },
                status: GridPreferenceReadStatus.Missing,
              }
            : {
                contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
                preference: preferenceRow(
                  options.serverValue,
                  options.serverRevision ?? 1
                ),
                status: GridPreferenceReadStatus.Found,
              };
        return jsonResponse(200, { data, success: true });
      }
      const status = options.writeStatus ?? 200;
      if (status !== 200) {
        return jsonResponse(status, { error: "rejected", success: false });
      }
      return jsonResponse(200, {
        data: {
          contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
          preference: preferenceRow({}, 2),
          status: GridPreferenceWriteStatus.Stored,
        },
        success: true,
      });
    },
    resolveApiOrigin: () => "https://api.test",
  };
  return { adapter, calls };
}

function createSequenceTransport(
  serverValues: readonly Record<string, unknown>[]
) {
  const calls: Call[] = [];
  let readIndex = 0;
  const adapter: ApiAdapter = {
    fetch: (_input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
      });
      if (method === "GET") {
        const serverValue =
          serverValues[Math.min(readIndex, serverValues.length - 1)] ?? null;
        readIndex += 1;
        const data =
          serverValue === null
            ? {
                contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
                selector: {
                  gridKey: GridPreferenceGridKey.Sessions,
                  preferenceKind: GridPreferenceKind.ViewState,
                  scopeKey: GridPreferenceScopeKey.Default,
                },
                status: GridPreferenceReadStatus.Missing,
              }
            : {
                contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
                preference: preferenceRow(serverValue, readIndex),
                status: GridPreferenceReadStatus.Found,
              };
        return jsonResponse(200, { data, success: true });
      }
      return jsonResponse(200, {
        data: {
          contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
          preference: preferenceRow({}, 2),
          status: GridPreferenceWriteStatus.Stored,
        },
        success: true,
      });
    },
    resolveApiOrigin: () => "https://api.test",
  };
  return { adapter, calls };
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    })
  );
}

function renderSubject(adapter: ApiAdapter, enabled = true) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiAdapterProvider adapter={adapter}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: true, userId: USER_ID })}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: enabled
              ? [GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY]
              : [],
          })}
        >
          {children}
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </ApiAdapterProvider>
  );
  return renderHook(() => useGridPreferenceTestView(), { wrapper });
}

function renderOrgScopedSubject(
  adapter: ApiAdapter,
  identity: { orgId: string }
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiAdapterProvider adapter={adapter}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          userId: USER_ID,
          orgId: identity.orgId,
        })}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [
              GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY,
              ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY,
            ],
          })}
        >
          {children}
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </ApiAdapterProvider>
  );
  return renderHook(() => useGridPreferenceTestView(), { wrapper });
}

function useGridPreferenceTestView() {
  return usePersistedTableViewState<SortKey, SortDir, ColumnId, Extras>({
    columnIds: COLUMN_IDS,
    defaultExtras: { revealed: false, window: "7d" },
    defaultSortDir: "asc",
    defaultSortKey: "name",
    gridKey: GridPreferenceGridKey.Sessions,
    keyPrefix: "test:view:",
    parse,
    persistKey: "web",
    sortDirs: ["asc", "desc"],
  });
}

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePersistedTableViewState ↔ grid preferences", () => {
  /**
   * The production-wiring assertion: a reorder/resize/visibility change reaches
   * the ISS-9448 route carrying the very bytes the hook wrote locally.
   *
   * COUNTERFACTUAL: delete the `remote.publish(serialized)` call in the persist
   * effect and no POST is ever issued, so this fails while every existing
   * localStorage suite stays green.
   */
  it("persists a reorder, a resize and a visibility change through the route", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport({ serverValue: null });
    const { result } = renderSubject(adapter);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const before = calls.filter((call) => call.method === "POST").length;

    act(() => {
      result.current.setColumnOrder(["c", "a", "b"]);
      result.current.setColumnWidth("a", 240);
      result.current.toggleColumn("b");
    });
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "POST").length).toBe(
        before + 1
      )
    );
    const written = calls.at(-1)?.body as { value: Record<string, unknown> };
    expect(written.value).toMatchObject({
      columnOrder: ["c", "a", "b"],
      columnWidths: { a: 240 },
      hiddenColumns: ["b"],
    });
    // The same bytes are on disk: one record, two copies, no second codec.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual(
      written.value
    );
  });

  /**
   * COUNTERFACTUAL: delete the inbound effect and the view keeps the local
   * layout, so `visibleColumns` still lacks `c` and this fails.
   */
  it("adopts the account's layout on mount", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hiddenColumns: ["c"], sortKey: "name" })
    );
    const { adapter } = createTransport({
      serverValue: { hiddenColumns: ["a"], sortKey: "date" },
      serverRevision: 5,
    });

    const { result } = renderSubject(adapter);

    await waitFor(() => expect(result.current.sortKey).toBe("date"));
    expect([...result.current.visibleColumns].sort()).toEqual(["b", "c"]);
  });

  it("uses the current organization local key when an org switch adopts the account row", async () => {
    const identity = { orgId: "org-a" };
    const { adapter, calls } = createSequenceTransport([
      { hiddenColumns: ["a"], sortKey: "date" },
      { hiddenColumns: ["b"], sortKey: "name" },
    ]);

    const { result, rerender } = renderOrgScopedSubject(adapter, identity);

    await waitFor(() => expect(result.current.sortKey).toBe("date"));
    expect(
      JSON.parse(localStorage.getItem(orgScopedStorageKey("org-a")) ?? "{}")
    ).toMatchObject({ hiddenColumns: ["a"], sortKey: "date" });

    identity.orgId = "org-b";
    act(() => rerender());

    await waitFor(() =>
      expect(result.current.visibleColumns.has("b")).toBe(false)
    );
    expect(result.current.sortKey).toBe("name");
    expect(
      JSON.parse(localStorage.getItem(orgScopedStorageKey("org-b")) ?? "{}")
    ).toMatchObject({ hiddenColumns: ["b"], sortKey: "name" });
    expect(
      JSON.parse(localStorage.getItem(orgScopedStorageKey("org-a")) ?? "{}")
    ).toMatchObject({ hiddenColumns: ["a"], sortKey: "date" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  /**
   * Honest rollback, end to end: the reader's change lands locally, the account
   * write is refused, and the view visibly returns to the last confirmed layout
   * — with the axes that write did NOT touch still on that confirmed record.
   *
   * COUNTERFACTUAL: make the failure path drop the delivery (return without
   * calling `deliver`) and the view keeps showing the rejected sort, so the
   * final assertion fails.
   */
  it("rolls the view back to the last confirmed layout when the write is refused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter } = createTransport({
      serverValue: { hiddenColumns: ["a"], sortKey: "name" },
      serverRevision: 4,
      writeStatus: 500,
    });
    const { result } = renderSubject(adapter);
    await vi.waitFor(() => expect(result.current.sortKey).toBe("name"));

    act(() => result.current.setSort("date"));
    expect(result.current.sortKey).toBe("date");
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(result.current.sortKey).toBe("name"));
    // The untouched axis survives the rollback rather than reverting to default.
    expect([...result.current.visibleColumns].sort()).toEqual(["b", "c"]);
  });

  /**
   * A record this build's parser cannot fully name. Every key the test-support
   * `parse` declares is present and set to what this build would write, so the
   * ONLY difference between the account's copy and this build's re-serialization
   * is `futureAxis` — a whole top-level axis added by a newer build.
   */
  const RECORD_WITH_FUTURE_AXIS = {
    columnOrder: [],
    columnWidths: {},
    futureAxis: { rows: ["x"] },
    hiddenColumns: [],
    pageSize: 50,
    revealed: false,
    sortDir: "asc",
    sortKey: "date",
    window: "7d",
  };

  /**
   * Opening an older client against a record with a future axis must not delete
   * it. The delivery is marked restored, so the persist effect re-serializes
   * immediately — on a mount where the reader changed nothing.
   *
   * COUNTERFACTUAL: drop the `opaqueFields` carry (how it was first written) and
   * the re-serialization is the STRIPPED record, which differs from what the
   * account confirmed — so a POST goes out deleting `futureAxis` from the
   * account, and the local copy loses it too. Both assertions fail.
   */
  it("carries a future axis through a mount that changes nothing", async () => {
    const { adapter, calls } = createTransport({
      serverValue: RECORD_WITH_FUTURE_AXIS,
      serverRevision: 5,
    });

    const { result } = renderSubject(adapter);
    await waitFor(() => expect(result.current.sortKey).toBe("date"));
    await waitFor(() =>
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
    );

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual(
      RECORD_WITH_FUTURE_AXIS
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  /**
   * COUNTERFACTUAL: as above — without the carry the edit's own write is the
   * stripped record, so `futureAxis` is absent from the posted value.
   */
  it("carries a future axis into the write a later edit makes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport({
      serverValue: RECORD_WITH_FUTURE_AXIS,
      serverRevision: 5,
    });
    const { result } = renderSubject(adapter);
    await vi.waitFor(() => expect(result.current.sortKey).toBe("date"));

    act(() => result.current.setSort("name"));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    );
    const written = calls.at(-1)?.body as { value: Record<string, unknown> };
    expect(written.value).toEqual({
      ...RECORD_WITH_FUTURE_AXIS,
      sortKey: "name",
    });
  });

  it("touches no route at all while the gate is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { adapter, calls } = createTransport({ serverValue: null });
    const { result } = renderSubject(adapter, false);

    act(() => result.current.setColumnWidth("a", 300));
    await act(async () => {
      vi.advanceTimersByTime(GRID_PREFERENCE_PUBLISH_DEBOUNCE_MS * 3);
      await Promise.resolve();
    });

    expect(calls).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});

function orgScopedStorageKey(orgId: string): string {
  return `test:view:web::id:${USER_ID}:${orgId}`;
}
