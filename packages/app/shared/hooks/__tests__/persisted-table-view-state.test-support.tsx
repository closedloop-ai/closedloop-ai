import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthAdapterProvider } from "../../auth/provider";
import {
  createStaticAuthAdapter,
  type StaticAuthOptions,
} from "../../auth/static-auth-adapter";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../use-persisted-table-view-state";

/**
 * The one concrete configuration every `usePersistedTableViewState` suite drives.
 *
 * Extracted (ISS-9692) so the page-size cases live in their own file without
 * re-declaring a second, subtly different subject — two suites configuring the
 * same generic hook slightly differently is how a shared machine's tests come to
 * disagree about what it does.
 */
export type SortKey = "name" | "date";
export type SortDir = "asc" | "desc";
export type ColumnId = "a" | "b" | "c";
export type Extras = { window: "7d" | "30d"; revealed: boolean };

export const COLUMN_IDS: readonly ColumnId[] = ["a", "b", "c"];

export function parse(
  raw: unknown
): RestoredTableView<SortKey, SortDir, Extras> | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const sortKey = record.sortKey === "date" ? "date" : "name";
  const sortDir = record.sortDir === "asc" ? "asc" : "desc";
  const hiddenColumns = Array.isArray(record.hiddenColumns)
    ? record.hiddenColumns.filter((id): id is string => typeof id === "string")
    : [];
  const columnOrder = Array.isArray(record.columnOrder)
    ? record.columnOrder.filter((id): id is string => typeof id === "string")
    : [];
  const columnWidths =
    record.columnWidths !== null &&
    typeof record.columnWidths === "object" &&
    !Array.isArray(record.columnWidths)
      ? (record.columnWidths as Record<string, number>)
      : {};
  return {
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    pageSize: typeof record.pageSize === "number" ? record.pageSize : undefined,
    extras: {
      window: record.window === "30d" ? "30d" : "7d",
      revealed: record.revealed === true,
    },
  };
}

export function useTestView(
  persistKey?: string,
  defaultHiddenColumns?: readonly ColumnId[]
) {
  return usePersistedTableViewState<SortKey, SortDir, ColumnId, Extras>({
    persistKey,
    keyPrefix: "test:view:",
    columnIds: COLUMN_IDS,
    defaultSortKey: "name",
    defaultSortDir: "asc",
    sortDirs: ["asc", "desc"],
    defaultExtras: { window: "7d", revealed: false },
    defaultHiddenColumns,
    parse,
  });
}

export function render(persistKey?: string) {
  return renderHook(() => useTestView(persistKey));
}

// Mount under a static auth adapter so the hook resolves a signed-in user and
// namespaces its storage key per user (FEA-4168, whitlockk review). A `null` userId
// models a signed-out surface; `isLoaded: false` models auth still hydrating,
// the state a real Clerk mount passes through before it resolves.
export function renderAsUser(
  userId: string | null,
  persistKey: string | undefined = "web",
  isLoaded = true
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({ isLoaded, userId })}
    >
      {children}
    </AuthAdapterProvider>
  );
  return renderHook(() => useTestView(persistKey), { wrapper });
}

/**
 * ISS-9449: mount a hook under an auth adapter the test can MOVE mid-mount —
 * loading → signed in, or one user → another — which is what the desktop
 * renderer's own provider does as its IPC-backed store hydrates.
 *
 * The wrapper reads a mutable binding rather than a prop: RTL fixes `wrapper`
 * at render time and forwards `rerender` props to the hook callback only, so a
 * fresh adapter has to reach the provider through a closure. Each `setAuth`
 * swaps the binding and rerenders inside `act`, and the hook sees a new
 * adapter object exactly as it would see a new snapshot from a live provider.
 */
export function renderHookWithAuth<TResult>(
  useHook: () => TResult,
  initialAuth: StaticAuthOptions
) {
  let adapter = createStaticAuthAdapter(initialAuth);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider adapter={adapter}>{children}</AuthAdapterProvider>
  );
  const rendered = renderHook(useHook, { wrapper });
  return {
    ...rendered,
    setAuth(next: StaticAuthOptions) {
      adapter = createStaticAuthAdapter(next);
      act(() => rendered.rerender());
    },
  };
}
