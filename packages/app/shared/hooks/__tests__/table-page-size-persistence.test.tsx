import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionsViewState } from "../../../agents/hooks/use-sessions-view-state";
import { useBranchViewState } from "../../../branches/hooks/use-branch-view-state";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "../../lib/feature-flags";

/**
 * ISS-9692 — the rows-per-page choice survives a reload and a navigate-away-and-
 * back, PER SURFACE, through the real persistence path.
 *
 * Each case unmounts the hook and mounts a fresh one, so nothing here can pass
 * on in-memory state: the second mount reads what the first actually wrote to
 * `localStorage`, exactly as a reload or a return visit does. A reload and a
 * navigate-away-and-back are the same event to these hooks — both are a fresh
 * mount against the same key — so one drive covers both.
 */
afterEach(() => {
  localStorage.clear();
});

const SESSIONS_KEY = "sessions:web";
const BRANCHES_KEY = "branches:web";

// The choice is durable only behind `table-page-size-ladder`, so every case that
// asserts durability mounts with the gate OPEN — and the closed-gate case at the
// bottom asserts the shipped behaviour is exactly what a reader without it gets.
function ladderWrapper(enabled: boolean) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY] : [],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

const renderSessions = (persistKey: string, enabled = true) =>
  renderHook(() => useSessionsViewState(persistKey), {
    wrapper: ladderWrapper(enabled),
  });

const renderBranches = (persistKey: string, enabled = true) =>
  renderHook(() => useBranchViewState(persistKey, true), {
    wrapper: ladderWrapper(enabled),
  });

describe("rows-per-page persistence", () => {
  it("restores a Sessions page size chosen on an earlier visit", () => {
    const first = renderSessions(SESSIONS_KEY);
    expect(first.result.current.pageSize).toBe(25);

    act(() => first.result.current.setPageSize(500));
    first.unmount();

    const second = renderSessions(SESSIONS_KEY);
    expect(second.result.current.pageSize).toBe(500);
  });

  it("restores a Branches page size chosen on an earlier visit", () => {
    const first = renderBranches(BRANCHES_KEY);
    act(() => first.result.current.setPageSize(250));
    first.unmount();

    const second = renderBranches(BRANCHES_KEY);
    expect(second.result.current.pageSize).toBe(250);
  });

  it("does not leak one surface's page size onto another", () => {
    const sessions = renderSessions(SESSIONS_KEY);
    act(() => sessions.result.current.setPageSize(500));
    sessions.unmount();

    const branches = renderBranches(BRANCHES_KEY);
    expect(branches.result.current.pageSize).toBe(25);

    // …and the reverse, so the assertion is about the KEYS and not about one
    // hook simply never reading storage at all.
    act(() => branches.result.current.setPageSize(250));
    branches.unmount();

    const sessionsAgain = renderSessions(SESSIONS_KEY);
    expect(sessionsAgain.result.current.pageSize).toBe(500);
  });

  it("does not leak the web Sessions page size onto the desktop Sessions view", () => {
    // The two hosts mount the SAME feature hook under different persist keys,
    // which is the only thing separating them.
    const web = renderSessions(SESSIONS_KEY);
    act(() => web.result.current.setPageSize(500));
    web.unmount();

    const desktop = renderSessions("sessions:desktop");
    expect(desktop.result.current.pageSize).toBe(25);
  });

  it("degrades a corrupt persisted Sessions page size to the surface default", () => {
    localStorage.setItem(
      `sessions:saved-view:${SESSIONS_KEY}`,
      JSON.stringify({
        columnOrder: [],
        dateRange: "7d",
        hiddenColumns: [],
        pageSize: -12,
        sortDir: "desc",
        sortKey: "lastActivity",
      })
    );

    const { result } = renderSessions(SESSIONS_KEY);

    expect(result.current.pageSize).toBe(25);
    // The rest of the stored view still restored, so the fallback above is the
    // page-size field degrading and not the whole parse failing.
    expect(result.current.dateRange).toBe("7d");
  });

  it("degrades a corrupt persisted Branches page size to the surface default", () => {
    localStorage.setItem(
      `branches:saved-view:${BRANCHES_KEY}:approved`,
      JSON.stringify({
        columnOrder: [],
        columnWidths: {},
        dateRange: "30d",
        hiddenColumns: [],
        pageSize: "lots",
        sortDir: "desc",
        sortKey: "lastActivity",
      })
    );

    const { result } = renderBranches(BRANCHES_KEY);

    expect(result.current.pageSize).toBe(25);
    expect(result.current.dateRange).toBe("30d");
  });

  it("does not make the choice durable while the ladder gate is closed", () => {
    // The closed-by-default half: a reader without the flag still moves the
    // control for this visit, and the next visit opens where it always has.
    const first = renderSessions(SESSIONS_KEY, false);
    act(() => first.result.current.setPageSize(100));
    expect(first.result.current.pageSize).toBe(100);
    first.unmount();

    const second = renderSessions(SESSIONS_KEY, false);
    expect(second.result.current.pageSize).toBe(25);
  });

  it("keeps a choice made while the gate was open rather than erasing it", () => {
    const open = renderSessions(SESSIONS_KEY);
    act(() => open.result.current.setPageSize(250));
    open.unmount();

    // The gate closes. The surface opens on the shipped ladder — the host
    // resolves 250 down to a still-offered rung — and shaping the view on some
    // OTHER dimension must not take the stored choice with it.
    const closed = renderSessions(SESSIONS_KEY, false);
    act(() => closed.result.current.setDateRange("30d"));
    closed.unmount();

    const reopened = renderSessions(SESSIONS_KEY);
    expect(reopened.result.current.pageSize).toBe(250);
  });
});
