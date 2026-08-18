import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardRefreshingIndicator,
  REFRESHING_LABEL,
  REFRESHING_MIN_VISIBLE_MS,
  REFRESHING_ONSET_MS,
  useDashboardRefreshing,
} from "../dashboard-refreshing";

const REFRESHING_RE = new RegExp(REFRESHING_LABEL, "i");

// A tiny harness that renders the indicator driven by the hook, so the test
// exercises the real production path (hook → indicator) and asserts the visible
// effect rather than the hook's return value in isolation.
function Harness(props: {
  requestKey: string;
  anyFetching: boolean;
  settled: boolean;
}) {
  const refreshing = useDashboardRefreshing(props);
  return <DashboardRefreshingIndicator refreshing={refreshing} />;
}

describe("useDashboardRefreshing + DashboardRefreshingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it("is a polite status live region even at rest (so AT can announce the transition)", () => {
    render(<Harness anyFetching={false} requestKey="90:me" settled={true} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
  });

  it("shows Refreshing after the onset delay when the request key changes while fetching", () => {
    const { rerender } = render(
      <Harness anyFetching={false} requestKey="90:me" settled={true} />
    );
    // User changes the range → new key, now fetching.
    rerender(<Harness anyFetching={true} requestKey="7:me" settled={true} />);

    // Nothing yet — the onset delay suppresses sub-perceptual refetches.
    expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
    advance(REFRESHING_ONSET_MS + 10);
    expect(screen.getByText(REFRESHING_RE)).toBeInTheDocument();
  });

  it("never shows for a refetch at the SAME request key (poll / db invalidation)", () => {
    const { rerender } = render(
      <Harness anyFetching={false} requestKey="90:me" settled={true} />
    );
    // Same key, but fetching flips true (a background poll).
    rerender(<Harness anyFetching={true} requestKey="90:me" settled={true} />);
    advance(REFRESHING_ONSET_MS + 50);

    expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
  });

  it("never shows before the first settle (so it can't compete with the skeletons)", () => {
    render(<Harness anyFetching={true} requestKey="90:me" settled={false} />);
    advance(REFRESHING_ONSET_MS + 50);

    expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
  });

  it("suppresses a warm-cache refetch that resolves before the onset delay", () => {
    const { rerender } = render(
      <Harness anyFetching={false} requestKey="90:me" settled={true} />
    );
    rerender(<Harness anyFetching={true} requestKey="7:me" settled={true} />);
    // Resolves quickly — fetching clears before the onset fires.
    advance(REFRESHING_ONSET_MS - 100);
    rerender(<Harness anyFetching={false} requestKey="7:me" settled={true} />);
    advance(500);

    expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
  });

  it("holds the indicator up for the minimum-visible floor after the refetch resolves", () => {
    const { rerender } = render(
      <Harness anyFetching={false} requestKey="90:me" settled={true} />
    );
    rerender(<Harness anyFetching={true} requestKey="7:me" settled={true} />);
    advance(REFRESHING_ONSET_MS + 10);
    expect(screen.getByText(REFRESHING_RE)).toBeInTheDocument();

    // Fetch resolves almost immediately after the indicator appeared.
    rerender(<Harness anyFetching={false} requestKey="7:me" settled={true} />);
    // Still up mid-floor (no stutter-off a frame later)...
    advance(REFRESHING_MIN_VISIBLE_MS - 100);
    expect(screen.getByText(REFRESHING_RE)).toBeInTheDocument();
    // ...and clears once the floor elapses.
    advance(200);
    expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
  });
});
