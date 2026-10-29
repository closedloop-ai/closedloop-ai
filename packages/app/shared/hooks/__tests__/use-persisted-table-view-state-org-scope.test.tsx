import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import type { FeatureFlagAdapter } from "../../feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY } from "../../lib/feature-flags";
import { VIEW_RESTORE_AUTH_DEADLINE_MS } from "../use-table-view-storage-key";
import { useTestView } from "./persisted-table-view-state.test-support";

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe("usePersistedTableViewState org-scoped namespacing (ISS-10091)", () => {
  it("namespaces the storage key by user and organization when the flag is enabled", () => {
    const { result } = renderOrgScopedTableView();

    act(() => result.current.setColumnWidth("b", 260));

    expect(localStorage.getItem(orgScopedKey())).not.toBeNull();
    expect(localStorage.getItem(userScopedKey())).toBeNull();
    expect(localStorage.getItem("test:view:web")).toBeNull();
    const stored = JSON.parse(localStorage.getItem(orgScopedKey()) ?? "null");
    expect(stored.columnWidths).toEqual({ b: 260 });
  });

  it("restores a per-user view as the first migration fallback", () => {
    localStorage.setItem(
      userScopedKey("user_alice"),
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );

    const { result } = renderOrgScopedTableView();

    expect(result.current.sortKey).toBe("date");
    expect(result.current.sortDir).toBe("desc");
    expect(result.current.visibleColumns.has("a")).toBe(false);
    const migrated = JSON.parse(localStorage.getItem(orgScopedKey()) ?? "null");
    expect(migrated).toMatchObject({ sortKey: "date", sortDir: "desc" });
    expect(localStorage.getItem(userScopedKey("user_alice"))).not.toBeNull();
  });

  it("prefers the org-scoped view over per-user and legacy fallbacks", () => {
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["b"],
        window: "30d",
        revealed: true,
      })
    );
    localStorage.setItem(
      userScopedKey("user_alice"),
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );
    localStorage.setItem(
      orgScopedKey("user_alice", "org_a"),
      JSON.stringify({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: ["c"],
        window: "7d",
        revealed: false,
      })
    );

    const { result } = renderOrgScopedTableView();

    expect(result.current.sortKey).toBe("name");
    expect(result.current.sortDir).toBe("asc");
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(result.current.visibleColumns.has("b")).toBe(true);
    expect(result.current.visibleColumns.has("c")).toBe(false);
  });

  it("re-restores the same user's view on an in-place organization switch", () => {
    localStorage.setItem(
      orgScopedKey("user_alice", "org_a"),
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );
    localStorage.setItem(
      orgScopedKey("user_alice", "org_b"),
      JSON.stringify({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: ["c"],
        window: "7d",
        revealed: false,
      })
    );

    let currentOrgId = "org_a";
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider adapter={orgScopedFeatureFlagAdapter()}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            userId: "user_alice",
            orgId: currentOrgId,
          })}
        >
          {children}
        </AuthAdapterProvider>
      </FeatureFlagAdapterProvider>
    );
    const { result, rerender } = renderHook(() => useTestView("web"), {
      wrapper,
    });

    expect(result.current.sortKey).toBe("date");
    expect(result.current.visibleColumns.has("a")).toBe(false);

    currentOrgId = "org_b";
    act(() => rerender());

    expect(result.current.sortKey).toBe("name");
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(result.current.visibleColumns.has("c")).toBe(false);
  });

  it("falls back to the per-user key after an unresolved flag deadline", () => {
    vi.useFakeTimers();
    localStorage.setItem(
      userScopedKey("user_alice"),
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );

    const { result } = renderOrgScopedTableView({
      enabled: true,
      resolved: false,
    });

    expect(result.current.isViewReady).toBe(false);
    act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));

    expect(result.current.isViewReady).toBe(true);
    expect(result.current.sortKey).toBe("date");
    expect(result.current.visibleColumns.has("a")).toBe(false);
    expect(localStorage.getItem(orgScopedKey())).toBeNull();
  });

  it("stays memory-only after the deadline when org scoping is enabled but org id is absent", () => {
    vi.useFakeTimers();
    const { result } = renderOrgScopedTableView({ orgId: null });

    expect(result.current.isViewReady).toBe(false);
    act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));
    expect(result.current.isViewReady).toBe(true);

    act(() => result.current.setColumnWidth("b", 260));
    expect(localStorage.length).toBe(0);
  });
});

type OrgScopedRenderOptions = {
  userId?: string | null;
  orgId?: string | null;
  enabled?: boolean;
  resolved?: boolean;
};

function renderOrgScopedTableView(options: OrgScopedRenderOptions = {}) {
  const {
    userId = "user_alice",
    orgId = "org_a",
    enabled = true,
    resolved = true,
  } = options;
  const featureFlagAdapter = resolved
    ? orgScopedFeatureFlagAdapter(enabled)
    : unresolvedOrgScopedFeatureFlagAdapter(enabled);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider adapter={featureFlagAdapter}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ userId, orgId })}>
        {children}
      </AuthAdapterProvider>
    </FeatureFlagAdapterProvider>
  );
  return renderHook(() => useTestView("web"), { wrapper });
}

function orgScopedFeatureFlagAdapter(enabled = true): FeatureFlagAdapter {
  return createStaticFeatureFlagAdapter({
    enabledFlags: enabled ? [ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY] : [],
  });
}

function unresolvedOrgScopedFeatureFlagAdapter(
  enabled: boolean
): FeatureFlagAdapter {
  return {
    useFeatureFlagEnabled: (key: string) =>
      key === ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY && enabled,
    useFeatureFlagResolved: () => false,
  };
}

function orgScopedKey(userId = "user_alice", orgId = "org_a"): string {
  return `test:view:web::id:${userId}:${orgId}`;
}

function userScopedKey(userId = "user_alice"): string {
  return `test:view:web:u:${userId}`;
}
