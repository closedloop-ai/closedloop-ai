import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDashboardScope } from "../use-dashboard-scope";

describe("useDashboardScope", () => {
  it("defaults to personal scope and hides org when only Me is available", () => {
    const { result } = renderHook(() => useDashboardScope([InsightsScope.Me]));

    expect(result.current.scope).toBe(InsightsScope.Me);
    expect(result.current.orgScopeAvailable).toBe(false);
  });

  it("switches to org when selected and org is available", () => {
    const { result } = renderHook(() =>
      useDashboardScope([InsightsScope.Me, InsightsScope.Org])
    );

    expect(result.current.orgScopeAvailable).toBe(true);
    act(() => result.current.setScope(InsightsScope.Org));
    expect(result.current.scope).toBe(InsightsScope.Org);
  });

  it("clamps a selected org scope back to Me when org stops being available", () => {
    const { result, rerender } = renderHook(
      ({ scopes }) => useDashboardScope(scopes),
      { initialProps: { scopes: [InsightsScope.Me, InsightsScope.Org] } }
    );

    act(() => result.current.setScope(InsightsScope.Org));
    expect(result.current.scope).toBe(InsightsScope.Org);

    // Cloud->Local flip: org disappears. The effective scope must clamp to Me
    // immediately so no stale org read reaches the local own-data store.
    rerender({ scopes: [InsightsScope.Me] });
    expect(result.current.scope).toBe(InsightsScope.Me);
    expect(result.current.orgScopeAvailable).toBe(false);
  });

  it("starts on personal scope even where org is available", () => {
    // The default both shells take (Marisol Ashgrove, 2026-09-30: "both should
    // default to 'Me'"). The Me-only case above cannot tell this apart from the
    // clamp, so this is the one that fails if the default drifts to Org.
    const { result } = renderHook(() =>
      useDashboardScope([InsightsScope.Me, InsightsScope.Org])
    );

    expect(result.current.orgScopeAvailable).toBe(true);
    expect(result.current.scope).toBe(InsightsScope.Me);
  });

  it("starts on the caller's default scope when it is available", () => {
    const { result } = renderHook(() =>
      useDashboardScope(
        [InsightsScope.Me, InsightsScope.Org],
        InsightsScope.Org
      )
    );

    expect(result.current.scope).toBe(InsightsScope.Org);
  });

  it("clamps a caller's org default to Me when org is not available", () => {
    // The web `/{orgSlug}/dashboard` route asks to start on `Org`; a source that
    // cannot serve it must still never be read org-wide.
    const { result } = renderHook(() =>
      useDashboardScope([InsightsScope.Me], InsightsScope.Org)
    );

    expect(result.current.scope).toBe(InsightsScope.Me);
    expect(result.current.orgScopeAvailable).toBe(false);
  });

  it("treats any non-org toggle value as personal scope", () => {
    const { result } = renderHook(() =>
      useDashboardScope([InsightsScope.Me, InsightsScope.Org])
    );

    act(() => result.current.setScope("team"));
    expect(result.current.scope).toBe(InsightsScope.Me);
  });
});
