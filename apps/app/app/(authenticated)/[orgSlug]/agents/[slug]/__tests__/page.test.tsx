import { AGENTS_NAV_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import AgentDetailPage from "../page";

const { headerMock } = vi.hoisted(() => ({
  headerMock: vi.fn(),
}));

const { notFoundMock, useFeatureFlagMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useFeatureFlagMock: vi.fn(),
}));

const { useFeatureFlagsLoadedMock, usePostHogDistinctIdMock, useUserMock } =
  vi.hoisted(() => ({
    useFeatureFlagsLoadedMock: vi.fn(),
    usePostHogDistinctIdMock: vi.fn(),
    useUserMock: vi.fn(),
  }));

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

vi.mock("@repo/analytics/client", () => ({
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: (flag: string) => useFeatureFlagMock(flag),
  useFeatureFlagsLoaded: () => useFeatureFlagsLoadedMock(),
  usePostHogDistinctId: () => usePostHogDistinctIdMock(),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => useUserMock(),
  // `AgentDetailWithPromote` reads membership to decide whether to offer the
  // promote action. Mocked here only because mocking this module at all (for
  // the gate's identify handshake) replaces the whole surface.
  useOrganization: () => ({ membership: null }),
}));

// The gate's `pending` chrome renders this on the pre-mount pass, before the
// flag has resolved. The real one reads `useSidebar`, which needs the shell's
// provider this route test does not mount.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div>Header chrome</div>,
}));

const IDENTIFIED_USER_ID = "user_identified_123";

vi.mock("@repo/app/agents/components/workspace/agent-detail", () => ({
  AgentDetail: ({ slug }: { slug: string }) => (
    <div data-slug={slug} data-testid="agent-detail" />
  ),
}));

// ISS-5518: the crumb moved behind this client boundary (the resolved component
// name only exists after the detail read). The page's own contract is that it
// hands BOTH children the same normalized slug; what the crumb then renders is
// pinned by `agent-detail-header.test.tsx`.
vi.mock("../agent-detail-header", () => ({
  AgentDetailHeader: (props: { orgSlug: string; slug: string }) =>
    headerMock(props),
}));

describe("AgentDetailPage (detail route)", () => {
  beforeEach(() => {
    headerMock.mockReset();
    headerMock.mockImplementation(({ slug }: { slug: string }) => (
      <div data-slug={slug} data-testid="header" />
    ));
    notFoundMock.mockClear();
    useFeatureFlagMock.mockReset();
    useUserMock.mockReturnValue({
      isLoaded: true,
      user: { id: IDENTIFIED_USER_ID },
    });
    useFeatureFlagsLoadedMock.mockReturnValue(true);
    usePostHogDistinctIdMock.mockReturnValue(IDENTIFIED_USER_ID);
    // The gate is open for every case below except the one that closes it, so
    // the slug contracts are asserted on the rendered body rather than on a
    // 404.
    useFeatureFlagMock.mockReturnValue({ enabled: true });
  });

  // ISS-5041/ISS-7835: replaces an "always-on (FEA-3994)" assertion. Reversed
  // deliberately — a DEEP LINK is what a stale bookmark or a shared URL holds,
  // so gating the index alone would leave the surface reachable.
  it("404s the deep link when the agentsNav flag is OFF", async () => {
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    const page = await AgentDetailPage({
      params: Promise.resolve({
        orgSlug: "test-org",
        slug: "some-agent-slug",
      }),
    });

    expect(() => render(page, { wrapper: WebFeatureFlagProvider })).toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(notFoundMock).toHaveBeenCalled();
    expect(useFeatureFlagMock).toHaveBeenCalledWith(
      AGENTS_NAV_FEATURE_FLAG_KEY
    );
    expect(screen.queryByTestId("agent-detail")).not.toBeInTheDocument();
  });

  it("renders AgentDetail when the agentsNav flag is ON", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({
          orgSlug: "test-org",
          slug: "some-agent-slug",
        }),
      }),
      { wrapper: WebFeatureFlagProvider }
    );

    expect(screen.getByTestId("agent-detail")).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("passes the org slug to the header so the Agents crumb stays org-scoped", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({
          orgSlug: "test-org",
          slug: "some-agent-slug",
        }),
      }),
      { wrapper: WebFeatureFlagProvider }
    );

    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "test-org" })
    );
  });

  it("passes the slug from params to AgentDetail", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({ orgSlug: "test-org", slug: "my-agent-uuid" }),
      }),
      { wrapper: WebFeatureFlagProvider }
    );

    expect(screen.getByTestId("agent-detail")).toHaveAttribute(
      "data-slug",
      "my-agent-uuid"
    );
  });

  // ISS-4776: the fix must land on the IDENTITY the page resolves, not just the
  // crumb label. The normalized slug must reach BOTH children — the header
  // (which decodes it for the crumb) and AgentDetail (which fetches
  // `/agent-components/{slug}` and the token-trend endpoint) — so the crumb and
  // the body key off the SAME literal `::`-bearing value. Otherwise the crumb
  // decodes to `//cl-ci-babysit` while the still-encoded slug misses the API
  // lookup and the body renders "not found" under it.
  it("passes the decoded (normalized) slug to both the header and AgentDetail", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({
          orgSlug: "test-org",
          slug: "command%3A%3A%2F%2Fcl-ci-babysit",
        }),
      }),
      { wrapper: WebFeatureFlagProvider }
    );

    expect(screen.getByTestId("agent-detail")).toHaveAttribute(
      "data-slug",
      "command:://cl-ci-babysit"
    );
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "command:://cl-ci-babysit" })
    );
  });
});
