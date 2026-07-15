import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SHARED_DASHBOARD_FIXTURE } from "../../lib/__tests__/fixtures";
import {
  DEFAULT_DASHBOARD_TILE_IDS,
  REMOVED_DASHBOARD_TILE_IDS,
} from "../../lib/tile-catalog";
import { useDashboardPins } from "../use-dashboard-pins";

const KEY = "closedloop:insights-dashboard:v1:org-a";

beforeEach(() => {
  localStorage.clear();
});

describe("useDashboardPins", () => {
  it("starts from the default tile set", () => {
    const { result } = renderHook(() => useDashboardPins("org-a"));
    expect(result.current.tiles).toEqual(DEFAULT_DASHBOARD_TILE_IDS);
  });

  it("toggles a tile on and off and persists to localStorage", () => {
    const { result } = renderHook(() => useDashboardPins("org-a"));

    act(() => result.current.togglePin("chart:prByRepo:donut"));
    expect(result.current.isPinned("chart:prByRepo:donut")).toBe(true);
    expect(localStorage.getItem(KEY)).toContain("chart:prByRepo:donut");

    act(() => result.current.togglePin("chart:prByRepo:donut"));
    expect(result.current.isPinned("chart:prByRepo:donut")).toBe(false);
  });

  it("persists grid layout positions", () => {
    const { result } = renderHook(() => useDashboardPins("org-a"));
    act(() =>
      result.current.setLayout({
        "kpi:merged": { x: 0, y: 0, w: 3, h: 2 },
      })
    );
    expect(result.current.layout["kpi:merged"]).toEqual({
      x: 0,
      y: 0,
      w: 3,
      h: 2,
    });
  });

  it("persists per-widget settings", () => {
    const { result } = renderHook(() => useDashboardPins("org-a"));
    act(() =>
      result.current.pinTile("chart:prTrend", { comparisonOverlay: true })
    );
    expect(result.current.isPinned("chart:prTrend")).toBe(true);
    expect(result.current.getTileSettings("chart:prTrend")).toEqual({
      comparisonOverlay: true,
    });

    act(() => result.current.unpinTile("chart:prTrend"));
    expect(result.current.isPinned("chart:prTrend")).toBe(false);
    expect(result.current.getTileSettings("chart:prTrend")).toEqual({});
  });

  it("replaces a widget while preserving its layout slot", () => {
    const { result } = renderHook(() => useDashboardPins("org-a"));
    act(() =>
      result.current.setLayout({
        "chart:modelBreakdown": { x: 6, y: 4, w: 6, h: 4 },
      })
    );

    act(() =>
      result.current.replaceTile(
        "chart:modelBreakdown",
        "chart:modelBreakdown:donut",
        { comparisonOverlay: true }
      )
    );

    expect(result.current.isPinned("chart:modelBreakdown")).toBe(false);
    expect(result.current.isPinned("chart:modelBreakdown:donut")).toBe(true);
    expect(result.current.layout["chart:modelBreakdown"]).toBeUndefined();
    expect(result.current.layout["chart:modelBreakdown:donut"]).toEqual({
      x: 6,
      y: 4,
      w: 6,
      h: 4,
    });
    expect(
      result.current.getTileSettings("chart:modelBreakdown:donut")
    ).toEqual({ comparisonOverlay: true });
  });

  it("falls back to defaults when stored JSON fails schema validation", () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 999, junk: true }));
    const { result } = renderHook(() => useDashboardPins("org-a"));
    expect(result.current.tiles).toEqual(DEFAULT_DASHBOARD_TILE_IDS);
  });

  it("adds analytics pie widgets and clears layout when migrating stored v3 dashboards", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 3,
        tiles: ["kpi:sessions", "chart:toolUsage"],
        layout: { "kpi:sessions": { x: 0, y: 0, w: 3, h: 2 } },
        settings: {},
      })
    );

    const { result } = renderHook(() => useDashboardPins("org-a"));
    expect(result.current.tiles).toEqual([
      "kpi:sessions",
      "chart:toolUsage",
      "chart:tokenDistribution",
      "chart:agentsByStatus",
      "chart:eventsByType",
      "chart:agentsByType:donut",
      "chart:toolUsage:donut",
      "chart:modelBreakdown:donut",
    ]);
    expect(result.current.layout).toEqual({});

    act(() => result.current.togglePin("chart:toolUsage"));
    expect(localStorage.getItem(KEY)).toContain('"version":7');
  });

  it("drops retired sessions-by-status tiles from current stored dashboards", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 7,
        tiles: [
          "chart:eventsByType",
          REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus,
          REMOVED_DASHBOARD_TILE_IDS.SessionsByStatusBar,
        ],
        layout: {
          "chart:eventsByType": { x: 0, y: 0, w: 6, h: 4 },
          [REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus]: {
            x: 6,
            y: 0,
            w: 6,
            h: 4,
          },
        },
        settings: {
          [REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus]: {
            comparisonOverlay: true,
          },
        },
      })
    );

    const { result } = renderHook(() => useDashboardPins("org-a"));
    expect(result.current.tiles).toEqual(["chart:eventsByType"]);
    expect(result.current.layout).toEqual({
      "chart:eventsByType": { x: 0, y: 0, w: 6, h: 4 },
    });
    expect(
      result.current.getTileSettings(
        REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus
      )
    ).toEqual({});
  });

  it("clears stacked layout when migrating stored v4 dashboards", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 4,
        tiles: ["kpi:tokens", "kpi:input-tokens", "kpi:output-tokens"],
        layout: {
          "kpi:tokens": { x: 0, y: 0, w: 3, h: 2 },
          "kpi:input-tokens": { x: 0, y: 2, w: 3, h: 2 },
          "kpi:output-tokens": { x: 0, y: 4, w: 3, h: 2 },
        },
        settings: {},
      })
    );

    const { result } = renderHook(() => useDashboardPins("org-a"));
    expect(result.current.layout).toEqual({});
    expect(result.current.tiles).toContain("chart:eventsByType");
  });

  it("preserves customized tiles when clearing stacked v5 layouts", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 5,
        tiles: ["kpi:tokens", "kpi:input-tokens", "kpi:output-tokens"],
        layout: {
          "kpi:tokens": { x: 0, y: 0, w: 3, h: 2 },
          "kpi:input-tokens": { x: 0, y: 2, w: 3, h: 2 },
          "kpi:output-tokens": { x: 0, y: 4, w: 3, h: 2 },
        },
        settings: {},
      })
    );

    const { result } = renderHook(() => useDashboardPins("org-a"));
    expect(result.current.layout).toEqual({});
    expect(result.current.tiles).toEqual([
      "kpi:tokens",
      "kpi:input-tokens",
      "kpi:output-tokens",
    ]);
  });

  it("resets a corrupted single-column v6 layout while preserving tiles and settings", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 6,
        tiles: ["kpi:input-tokens", "kpi:output-tokens", "chart:prTrend"],
        // Pre-fix corruption: every tile rewritten to a full-width stack at x:0.
        layout: {
          "kpi:input-tokens": { x: 0, y: 0, w: 12, h: 2 },
          "kpi:output-tokens": { x: 0, y: 2, w: 12, h: 2 },
          "chart:prTrend": { x: 0, y: 4, w: 12, h: 4 },
        },
        settings: { "chart:prTrend": { comparisonOverlay: true } },
      })
    );

    const { result } = renderHook(() => useDashboardPins("org-a"));
    expect(result.current.layout).toEqual({});
    expect(result.current.tiles).toEqual([
      "kpi:input-tokens",
      "kpi:output-tokens",
      "chart:prTrend",
    ]);
    expect(result.current.getTileSettings("chart:prTrend")).toEqual({
      comparisonOverlay: true,
    });

    act(() => result.current.togglePin("kpi:input-tokens"));
    expect(localStorage.getItem(KEY)).toContain('"version":7');
  });

  it("preserves a clean multi-column v6 layout on upgrade", () => {
    const cleanLayout = {
      "kpi:input-tokens": { x: 0, y: 0, w: 3, h: 2 },
      "kpi:output-tokens": { x: 3, y: 0, w: 3, h: 2 },
      "chart:prTrend": { x: 6, y: 0, w: 6, h: 4 },
    };
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 6,
        tiles: [
          "kpi:input-tokens",
          REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus,
          "kpi:output-tokens",
          "chart:prTrend",
        ],
        layout: {
          ...cleanLayout,
          [REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus]: {
            x: 9,
            y: 0,
            w: 3,
            h: 4,
          },
        },
        settings: {
          "chart:prTrend": { comparisonOverlay: true },
          [REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus]: {
            comparisonOverlay: true,
          },
        },
      })
    );

    const { result } = renderHook(() => useDashboardPins("org-a"));
    // Tiles sit at varying x — not the corrupted single-column stack — so the
    // customized arrangement must survive the v6 -> v7 upgrade while retired
    // sessions-by-status tile state is removed.
    expect(result.current.layout).toEqual(cleanLayout);
    expect(result.current.tiles).toEqual([
      "kpi:input-tokens",
      "kpi:output-tokens",
      "chart:prTrend",
    ]);
    expect(result.current.getTileSettings("chart:prTrend")).toEqual({
      comparisonOverlay: true,
    });
    expect(
      result.current.getTileSettings(
        REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus
      )
    ).toEqual({});

    act(() => result.current.togglePin("kpi:input-tokens"));
    expect(localStorage.getItem(KEY)).toContain('"version":7');
  });

  it("namespaces storage per shell/org", () => {
    const { result: orgA } = renderHook(() => useDashboardPins("org-a"));
    act(() => orgA.current.togglePin("chart:prByRepo:donut"));

    const { result: orgB } = renderHook(() => useDashboardPins("org-b"));
    expect(orgB.current.isPinned("chart:prByRepo:donut")).toBe(false);
  });

  describe("shared dashboard override", () => {
    const OVERRIDE = SHARED_DASHBOARD_FIXTURE;

    it("renders the shared snapshot instead of the stored dashboard", () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          version: 7,
          tiles: ["kpi:sessions"],
          layout: {},
          settings: {},
        })
      );

      const { result } = renderHook(() => useDashboardPins("org-a", OVERRIDE));

      expect(result.current.tiles).toEqual(OVERRIDE.tiles);
      expect(result.current.layout).toEqual(OVERRIDE.layout);
      expect(result.current.getTileSettings("chart:prTrend")).toEqual({
        comparisonOverlay: true,
      });
    });

    it("keeps edits ephemeral without touching the recipient's stored dashboard", () => {
      const storedValue = JSON.stringify({
        version: 7,
        tiles: ["kpi:sessions"],
        layout: {},
        settings: {},
      });
      localStorage.setItem(KEY, storedValue);

      const { result } = renderHook(() => useDashboardPins("org-a", OVERRIDE));

      act(() => result.current.togglePin("kpi:sessions"));

      // The edit is reflected in the live (shared) view...
      expect(result.current.isPinned("kpi:sessions")).toBe(true);
      // ...but localStorage still holds the recipient's own dashboard.
      expect(localStorage.getItem(KEY)).toBe(storedValue);
    });

    it("strips retired tiles carried by an older shared link", () => {
      const { result } = renderHook(() =>
        useDashboardPins("org-a", {
          tiles: ["kpi:merged", REMOVED_DASHBOARD_TILE_IDS.SessionsByStatus],
          layout: {},
          settings: {},
        })
      );

      expect(result.current.tiles).toEqual(["kpi:merged"]);
    });

    it("discards ephemeral edits when the shared dashboard changes identity", () => {
      const overrideB: typeof OVERRIDE = {
        tiles: ["kpi:sessions"],
        layout: {},
        settings: {},
      };

      const { result, rerender } = renderHook(
        ({ override }) => useDashboardPins("org-a", override),
        { initialProps: { override: OVERRIDE } }
      );

      // Edit while previewing dashboard A.
      act(() => result.current.togglePin("kpi:sessions"));
      expect(result.current.isPinned("kpi:sessions")).toBe(true);

      // Switching to a different shared dashboard (e.g. ?dash=A -> ?dash=B) must
      // drop A's ephemeral edits and render B's snapshot verbatim, not A's edits
      // painted over B.
      rerender({ override: overrideB });

      expect(result.current.tiles).toEqual(overrideB.tiles);
    });

    it("falls back to the stored dashboard when no override is provided", () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          version: 7,
          tiles: ["kpi:sessions"],
          layout: {},
          settings: {},
        })
      );

      const { result } = renderHook(() => useDashboardPins("org-a", null));

      expect(result.current.tiles).toEqual(["kpi:sessions"]);
    });
  });
});
