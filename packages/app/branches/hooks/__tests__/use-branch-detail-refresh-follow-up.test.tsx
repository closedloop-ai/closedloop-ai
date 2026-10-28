import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS,
  BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT,
  useBranchDetailRefreshFollowUp,
} from "../use-branch-detail-refresh-follow-up";

type Props = { pending: boolean; detailKey: string; dataUpdatedAt: number };

describe("useBranchDetailRefreshFollowUp (ISS-12278)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function render(initial: Props) {
    const refetch = vi.fn(() => Promise.resolve());
    const hook = renderHook(
      ({ pending, detailKey, dataUpdatedAt }: Props) =>
        useBranchDetailRefreshFollowUp(
          pending,
          detailKey,
          dataUpdatedAt,
          refetch
        ),
      { initialProps: initial }
    );
    return { refetch, ...hook };
  }

  it("refetches once after the delay when a refresh is pending", () => {
    const { refetch } = render({
      pending: true,
      detailKey: "branch-a",
      dataUpdatedAt: 1,
    });

    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS - 1);
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when no refresh is pending", () => {
    const { refetch } = render({
      pending: false,
      detailKey: "branch-a",
      dataUpdatedAt: 1,
    });

    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS * 3);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("follows up again while a refetched detail still reports the refresh in flight", () => {
    const { refetch, rerender } = render({
      pending: true,
      detailKey: "branch-a",
      dataUpdatedAt: 1,
    });
    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);
    rerender({ pending: true, detailKey: "branch-a", dataUpdatedAt: 2 });
    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);

    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("never becomes a poll: follow-ups stop at the per-key limit", () => {
    const { refetch, rerender } = render({
      pending: true,
      detailKey: "branch-a",
      dataUpdatedAt: 0,
    });
    for (
      let fetch = 1;
      fetch <= BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT + 2;
      fetch++
    ) {
      vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);
      rerender({ pending: true, detailKey: "branch-a", dataUpdatedAt: fetch });
    }
    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS * 3);

    expect(refetch).toHaveBeenCalledTimes(
      BRANCH_DETAIL_REFRESH_FOLLOW_UP_LIMIT
    );
  });

  it("stops following up once the refreshed detail no longer reports one", () => {
    const { refetch, rerender } = render({
      pending: true,
      detailKey: "branch-a",
      dataUpdatedAt: 1,
    });
    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);
    rerender({ pending: false, detailKey: "branch-a", dataUpdatedAt: 2 });
    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS * 3);

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("follows up again for a different detail key", () => {
    const { refetch, rerender } = render({
      pending: true,
      detailKey: "branch-a",
      dataUpdatedAt: 1,
    });
    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);
    rerender({ pending: true, detailKey: "branch-b", dataUpdatedAt: 2 });
    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);

    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("cancels the pending follow-up on unmount", () => {
    const { refetch, unmount } = render({
      pending: true,
      detailKey: "branch-a",
      dataUpdatedAt: 1,
    });
    unmount();

    vi.advanceTimersByTime(BRANCH_DETAIL_REFRESH_FOLLOW_UP_DELAY_MS);
    expect(refetch).not.toHaveBeenCalled();
  });
});
