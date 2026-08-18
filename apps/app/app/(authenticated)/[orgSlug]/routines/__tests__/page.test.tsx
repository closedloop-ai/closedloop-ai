import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RoutinesPage from "../page";

// FEA-4348: the web Routines route is gated behind the PostHog `routines` flag
// (default off) until GA. Deep-linking `/routines` with the flag off must land
// on the in-shell "Page not found" recovery state (via `notFound()`), and with
// the flag on must render the real Routines body. These tests drive the page
// through the real `FeatureFlagRouteGate`, mocking only the analytics/auth flag
// inputs and the heavy leaf children, so the assertions are on the route's
// observable ON/OFF behavior — not just wiring.

const { notFoundMock, useFeatureFlagMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useFeatureFlagMock: vi.fn(),
}));

const { useFeatureFlagsLoadedMock, usePostHogDistinctIdMock } = vi.hoisted(
  () => ({
    useFeatureFlagsLoadedMock: vi.fn(),
    usePostHogDistinctIdMock: vi.fn(),
  })
);

const { useUserMock } = vi.hoisted(() => ({ useUserMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("@repo/analytics/client", () => ({
  // These drive the anonymous-bootstrap -> identify() handshake, which only
  // exists in a build that has a PostHog key.
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: (flag: string) => useFeatureFlagMock(flag),
  useFeatureFlagsLoaded: () => useFeatureFlagsLoadedMock(),
  usePostHogDistinctId: () => usePostHogDistinctIdMock(),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => useUserMock(),
}));

const ROUTINES_BODY_TEXT = "Routines index body";

vi.mock("../../../components/header", () => ({
  Header: () => <div>Header chrome</div>,
}));

vi.mock("../components/routines-index-view", () => ({
  RoutinesIndexView: () => <div>{ROUTINES_BODY_TEXT}</div>,
}));

const IDENTIFIED_USER_ID = "user_identified_123";

/** The steady state: signed-in user identified in PostHog, flags loaded. */
function settledIdentifiedState() {
  useUserMock.mockReturnValue({
    isLoaded: true,
    user: { id: IDENTIFIED_USER_ID },
  });
  useFeatureFlagsLoadedMock.mockReturnValue(true);
  usePostHogDistinctIdMock.mockReturnValue(IDENTIFIED_USER_ID);
}

describe("RoutinesPage — routines PostHog gate (FEA-4348)", () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    useFeatureFlagMock.mockReset();
    useFeatureFlagsLoadedMock.mockReset();
    usePostHogDistinctIdMock.mockReset();
    useUserMock.mockReset();
  });

  it("404s the route (notFound) when the routines flag is OFF for the identified user", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    // notFound() throws NEXT_NOT_FOUND, which the App Router turns into the
    // in-shell not-found page — the graceful pre-GA recovery state.
    expect(() => render(<RoutinesPage />)).toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalled();
    expect(useFeatureFlagMock).toHaveBeenCalledWith(ROUTINES_FEATURE_FLAG_KEY);
    expect(screen.queryByText(ROUTINES_BODY_TEXT)).not.toBeInTheDocument();
  });

  it("renders the Routines body when the routines flag is ON", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    render(<RoutinesPage />);

    expect(useFeatureFlagMock).toHaveBeenCalledWith(ROUTINES_FEATURE_FLAG_KEY);
    expect(screen.getByText(ROUTINES_BODY_TEXT)).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
