import { AGENTS_NAV_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import AgentsPage from "../page";

// ISS-5041/ISS-7835: the Agents route is gated behind the PostHog `agentsNav`
// flag (default off), the same key the desktop Labs toggle uses. Gating the nav
// alone would leave `/agents` reachable by URL, so these drive the page through
// the REAL `FeatureFlagRouteGate` and assert the route's observable ON/OFF
// behavior — a deep link with the flag off must land on the in-shell "Page not
// found" recovery state via `notFound()`, not open the surface.
//
// This replaces an "always-on (FEA-3994)" assertion. That expectation is not
// weakened, it is REVERSED on purpose: FEA-3994 graduating Agents past its flag
// is the root cause ISS-7835 identifies, because it left the customer view with
// nothing to suppress.
//
// The href contract that suite also covered has MOVED to
// `../components/__tests__/agents-list-host.test.tsx` (whitlockk review on PR
// #6803). It cannot live here: this file mocks `AgentsListHost` away to isolate
// the route gate, so any href it asserted would be its own mock's, green no
// matter what the real factory does — and the rule it asserted, "a UUID and
// never a colon", is the opposite of what production does. `AgentsListHost`
// routes with `encodeURIComponent(item.slug)` and the detail route is
// `[slug]`, whose param IS the `kind::key` org-identity slug. The replacement
// drives the real host and pins the real shape.
const AGENT_LINK_NAME = "My Test Agent";

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

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

vi.mock("@repo/analytics/client", () => ({
  // These drive the anonymous-bootstrap -> identify() handshake, which only
  // exists in a build that has a PostHog key.
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: (flag: string) => useFeatureFlagMock(flag),
  useFeatureFlagsLoaded: () => useFeatureFlagsLoadedMock(),
  usePostHogDistinctId: () => usePostHogDistinctIdMock(),
}));

vi.mock("@repo/auth/client", () => ({ useUser: () => useUserMock() }));

vi.mock(
  "@/app/(authenticated)/[orgSlug]/agents/components/agents-list-host",
  () => ({
    /**
     * A named link and nothing more. This stands in for "the surface mounted",
     * which is all the route gate below is about; its `href` is deliberately
     * inert so no test here can mistake it for the production href factory.
     */
    AgentsListHost: () => (
      <ul>
        <li>
          <a href="#mounted">{AGENT_LINK_NAME}</a>
        </li>
      </ul>
    ),
  })
);

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div>Header chrome</div>,
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

describe("AgentsPage — agentsNav route gate (ISS-5041 / ISS-7835)", () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    useFeatureFlagMock.mockReset();
    useFeatureFlagsLoadedMock.mockReset();
    usePostHogDistinctIdMock.mockReset();
    useUserMock.mockReset();
    settledIdentifiedState();
  });

  it("404s the route when the agentsNav flag is OFF for the identified user", () => {
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    expect(() =>
      render(<AgentsPage />, { wrapper: WebFeatureFlagProvider })
    ).toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalled();
    // Keyed on the flag, not merely "some flag was read": a gate on the wrong
    // key would 404 here and leave the real one ungated.
    expect(useFeatureFlagMock).toHaveBeenCalledWith(
      AGENTS_NAV_FEATURE_FLAG_KEY
    );
    expect(screen.queryByText(AGENT_LINK_NAME)).not.toBeInTheDocument();
  });

  it("renders the agents list when the agentsNav flag is ON", () => {
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    render(<AgentsPage />, { wrapper: WebFeatureFlagProvider });

    expect(useFeatureFlagMock).toHaveBeenCalledWith(
      AGENTS_NAV_FEATURE_FLAG_KEY
    );
    expect(
      screen.getByRole("link", { name: AGENT_LINK_NAME })
    ).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
