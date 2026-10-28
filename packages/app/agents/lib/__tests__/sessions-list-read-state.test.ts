import { CompleteSurfaceState } from "@repo/app/shared/lib/complete-surface-contract";
import { describe, expect, it } from "vitest";
import {
  resolveSessionsListReadModel,
  SessionsListReadState,
  selectSessionsListSurfaceState,
} from "../sessions-list-read-state";

describe("resolveSessionsListReadModel", () => {
  it("treats a closed restore gate as unknown rather than zero", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: false,
      hasData: false,
      isLoading: false,
      rowCount: 0,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      isPending: true,
      state: SessionsListReadState.Restoring,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });

  it("suppresses placeholder totals even when cached rows are visible", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      isPlaceholderData: true,
      knownTotal: 431,
      rowCount: 25,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      isRangeUnsettled: true,
      state: SessionsListReadState.Placeholder,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });

  it("reports offline and live failures as read errors until a read lands", () => {
    expect(
      resolveSessionsListReadModel({
        canRead: true,
        hasData: false,
        isLoadingError: true,
        rowCount: 0,
      })
    ).toMatchObject({
      hasKnownTotal: false,
      isUnavailable: true,
      state: SessionsListReadState.Error,
    });
  });

  it("keeps a gated no-data read pending ahead of cached error flags", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: false,
      hasData: false,
      isError: true,
      isLoading: true,
      isLoadingError: true,
      rowCount: 0,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      isPending: true,
      isUnavailable: false,
      state: SessionsListReadState.Loading,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });

  it("preserves settled zero as a real total", () => {
    expect(
      resolveSessionsListReadModel({
        canRead: true,
        hasData: true,
        knownTotal: 0,
        rowCount: 0,
      })
    ).toMatchObject({
      hasKnownTotal: true,
      isRangeUnsettled: false,
      state: SessionsListReadState.Settled,
      totalRows: 0,
    });
  });

  it("renders rows without inventing a total when a version-skewed read omits it", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      rowCount: 3,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      state: SessionsListReadState.Partial,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });

  it("routes an empty landed read without a trusted total to unavailable", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      rowCount: 0,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      isPending: false,
      isUnavailable: true,
      state: SessionsListReadState.Unavailable,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });

  it("keeps a no-data read without a trusted total pending", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: false,
      rowCount: 0,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      isPending: true,
      isUnavailable: false,
      state: SessionsListReadState.Loading,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("withholds invalid %s totals from settled pagination", (_name, total) => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      knownTotal: total,
      rowCount: 3,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      state: SessionsListReadState.Partial,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });

  it("routes an empty landed read with an invalid total to unavailable", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      knownTotal: -1,
      rowCount: 0,
    });

    expect(readModel).toMatchObject({
      hasKnownTotal: false,
      isPending: false,
      isUnavailable: true,
      state: SessionsListReadState.Unavailable,
    });
    expect(readModel).not.toHaveProperty("totalRows");
  });
});

describe("selectSessionsListSurfaceState", () => {
  it("maps restore, loading, and syncing reads to loading", () => {
    for (const readModel of [
      resolveSessionsListReadModel({
        canRead: false,
        hasData: false,
        rowCount: 0,
      }),
      resolveSessionsListReadModel({
        canRead: true,
        hasData: false,
        isLoading: true,
        rowCount: 0,
      }),
      resolveSessionsListReadModel({
        canRead: true,
        hasData: false,
        isSyncing: true,
        rowCount: 0,
      }),
    ]) {
      expect(
        selectSessionsListSurfaceState({
          hasActiveFilters: false,
          hasCompletePopulation: false,
          readModel,
          visibleRowCount: 0,
        })
      ).toBe(CompleteSurfaceState.Loading);
    }
  });

  it("maps failed reads without inventing an empty population", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: false,
      isError: true,
      rowCount: 0,
    });

    expect(
      selectSessionsListSurfaceState({
        hasActiveFilters: true,
        hasCompletePopulation: false,
        readModel,
        visibleRowCount: 0,
      })
    ).toBe(CompleteSurfaceState.Error);
  });

  it("maps unavailable reads without inventing an empty population", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      knownTotal: -1,
      rowCount: 0,
    });

    expect(
      selectSessionsListSurfaceState({
        hasActiveFilters: true,
        hasCompletePopulation: false,
        readModel,
        visibleRowCount: 0,
      })
    ).toBe(CompleteSurfaceState.Unavailable);
  });

  it("maps placeholder and partial reads to partial even when rows are visible", () => {
    for (const readModel of [
      resolveSessionsListReadModel({
        canRead: true,
        hasData: true,
        isPlaceholderData: true,
        knownTotal: 8,
        rowCount: 2,
      }),
      resolveSessionsListReadModel({
        canRead: true,
        hasData: true,
        rowCount: 2,
      }),
    ]) {
      expect(
        selectSessionsListSurfaceState({
          hasActiveFilters: false,
          hasCompletePopulation: false,
          readModel,
          visibleRowCount: 2,
        })
      ).toBe(CompleteSurfaceState.Partial);
    }
  });

  it("maps settled visible rows to ready when the population is complete", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      knownTotal: 3,
      rowCount: 3,
    });

    expect(
      selectSessionsListSurfaceState({
        hasActiveFilters: false,
        hasCompletePopulation: true,
        readModel,
        visibleRowCount: 3,
      })
    ).toBe(CompleteSurfaceState.Ready);
  });

  it("keeps settled visible rows partial when the population is incomplete", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      knownTotal: 10,
      rowCount: 3,
    });

    expect(
      selectSessionsListSurfaceState({
        hasActiveFilters: false,
        hasCompletePopulation: false,
        readModel,
        visibleRowCount: 3,
      })
    ).toBe(CompleteSurfaceState.Partial);
  });

  it("distinguishes filtered and genuine settled zero states", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      knownTotal: 0,
      rowCount: 0,
    });

    expect(
      selectSessionsListSurfaceState({
        hasActiveFilters: true,
        hasCompletePopulation: true,
        readModel,
        visibleRowCount: 0,
      })
    ).toBe(CompleteSurfaceState.FilteredEmpty);
    expect(
      selectSessionsListSurfaceState({
        hasActiveFilters: false,
        hasCompletePopulation: true,
        readModel,
        visibleRowCount: 0,
      })
    ).toBe(CompleteSurfaceState.GenuineEmpty);
  });

  it("does not call a settled page ready when the trusted total says rows exist elsewhere", () => {
    const readModel = resolveSessionsListReadModel({
      canRead: true,
      hasData: true,
      knownTotal: 10,
      rowCount: 0,
    });

    expect(
      selectSessionsListSurfaceState({
        hasActiveFilters: false,
        hasCompletePopulation: false,
        readModel,
        visibleRowCount: 0,
      })
    ).toBe(CompleteSurfaceState.Partial);
  });
});
