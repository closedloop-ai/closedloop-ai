/**
 * ISS-5574: the session detail route's browser tab title. Asserts the REAL
 * `document.title` after rendering the page, per record state — a loaded name, a
 * nameless record falling back to its external id, an unresolved read, and the
 * flag-off default.
 */
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionDetailPage from "../page";

const {
  featureFlagEnabledMock,
  headerMock,
  routeParamsMock,
  searchParamsMock,
  sharedDetailViewMock,
  useAgentSessionDetailMock,
} = vi.hoisted(() => ({
  featureFlagEnabledMock: vi.fn(),
  headerMock: vi.fn(),
  routeParamsMock: vi.fn(),
  searchParamsMock: vi.fn(),
  sharedDetailViewMock: vi.fn(),
  useAgentSessionDetailMock: vi.fn(),
}));

vi.mock("@repo/app/agents/components/detail/agent-session-detail-view", () => ({
  AgentSessionDetailView: sharedDetailViewMock,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionDetail: useAgentSessionDetailMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
  useFeatureFlagEnabledOptional: (flag: string) => featureFlagEnabledMock(flag),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: routeParamsMock,
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock(
  "@/app/(authenticated)/components/session-detail-header-controls",
  () => ({
    SessionDetailActions: () => null,
    SessionDetailOverflowMenu: () => null,
  })
);

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

/** The root layout's default (`apps/app/app/layout.tsx`) — the pre-ISS-5574 title. */
const ROOT_LAYOUT_TITLE = "Closedloop.ai";
const SESSION_ID = "ses-1";

describe("ISS-5574: session detail tab title", () => {
  beforeEach(() => {
    document.title = ROOT_LAYOUT_TITLE;
    headerMock.mockReset();
    headerMock.mockImplementation(() => null);
    sharedDetailViewMock.mockReset();
    sharedDetailViewMock.mockImplementation(() => null);
    routeParamsMock.mockReset();
    routeParamsMock.mockReturnValue({ id: SESSION_ID });
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
    useAgentSessionDetailMock.mockReset();
    featureFlagEnabledMock.mockReset();
    featureFlagEnabledMock.mockImplementation(
      (flag: string) => flag === SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
    );
  });

  afterEach(() => {
    document.title = ROOT_LAYOUT_TITLE;
  });

  it("names the tab after the session", () => {
    useAgentSessionDetailMock.mockReturnValue({
      data: createAgentSessionDetailFixture({
        id: SESSION_ID,
        name: "symphony-alpha-iss-5273",
      }),
      isError: false,
      isLoading: false,
    });

    render(<SessionDetailPage />);

    expect(document.title).toBe("symphony-alpha-iss-5273 | Closedloop.ai");
  });

  it("falls back to the external id for a nameless session", () => {
    useAgentSessionDetailMock.mockReturnValue({
      data: createAgentSessionDetailFixture({
        externalSessionId: "ext-9",
        id: SESSION_ID,
        name: null,
      }),
      isError: false,
      isLoading: false,
    });

    render(<SessionDetailPage />);

    expect(document.title).toBe("ext-9 | Closedloop.ai");
  });

  it("says only the honest kind while the record is unresolved", () => {
    // Loading — no name is known, so the tab names the KIND of page rather than
    // holding a placeholder that would read as the session's name.
    useAgentSessionDetailMock.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: true,
    });

    render(<SessionDetailPage />);

    expect(document.title).toBe("Session | Closedloop.ai");
  });

  it("leaves the default title in place with the flag off", () => {
    featureFlagEnabledMock.mockReturnValue(false);
    useAgentSessionDetailMock.mockReturnValue({
      data: createAgentSessionDetailFixture({
        id: SESSION_ID,
        name: "symphony-alpha-iss-5273",
      }),
      isError: false,
      isLoading: false,
    });

    render(<SessionDetailPage />);

    expect(document.title).toBe(ROOT_LAYOUT_TITLE);
  });
});
