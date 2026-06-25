import { GroupByMode } from "@repo/app/documents/lib/group-by";
import type { NavigationActions } from "@repo/navigation/navigation-adapter";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const featureFlagEnabledMock = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => featureFlagEnabledMock(key),
}));

import { useStackRankReset } from "../use-stack-rank-reset";

function setup(
  flagEnabled: boolean,
  searchParams = new URLSearchParams("filter=open&sortBy=status&sortDir=desc")
) {
  featureFlagEnabledMock.mockReturnValue(flagEnabled);
  const clearSort = vi.fn();
  const setGroupBy = vi.fn();
  const replace = vi.fn();
  const navigation = {
    navigate: vi.fn(),
    replace,
    back: vi.fn(),
    refresh: vi.fn(),
  } satisfies NavigationActions;

  const { result } = renderHook(() =>
    useStackRankReset({
      clearSort,
      setGroupBy,
      searchParams,
      navigation,
      pathname: "/x/teams/y/projects/z",
    })
  );

  return { handler: result.current, clearSort, setGroupBy, replace };
}

describe("useStackRankReset (PLN-755 Phase D)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when the feature flag is off", () => {
    const { handler } = setup(false);
    expect(handler).toBeUndefined();
  });

  it("returns a working handler when the feature flag is on", () => {
    const { handler, clearSort, setGroupBy, replace } = setup(true);
    expect(handler).toBeInstanceOf(Function);

    act(() => {
      handler?.();
    });

    expect(clearSort).toHaveBeenCalledTimes(1);
    expect(setGroupBy).toHaveBeenCalledWith(GroupByMode.None);
    // sortBy / sortDir stripped from query, unrelated `filter=open` preserved.
    expect(replace).toHaveBeenCalledWith("/x/teams/y/projects/z?filter=open", {
      scroll: false,
    });
  });

  it("falls back to bare pathname when no other params remain", () => {
    const { handler, clearSort, setGroupBy, replace } = setup(
      true,
      new URLSearchParams("sortBy=status&sortDir=desc")
    );

    act(() => {
      handler?.();
    });

    expect(clearSort).toHaveBeenCalledTimes(1);
    expect(setGroupBy).toHaveBeenCalledWith(GroupByMode.None);
    expect(replace).toHaveBeenCalledWith("/x/teams/y/projects/z", {
      scroll: false,
    });
  });
});
