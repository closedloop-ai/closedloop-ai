import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "../page";

const { headerMock } = vi.hoisted(() => ({
  headerMock: vi.fn(),
}));

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
  });

  it("renders AgentDetail unconditionally (always-on, FEA-3994)", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({
          orgSlug: "test-org",
          slug: "some-agent-slug",
        }),
      })
    );

    // AgentDetail renders directly, no longer behind a feature-flag gate.
    expect(
      screen.getByTestId("agent-detail").closest("[data-feature-flag]")
    ).toBeNull();
    expect(screen.getByTestId("agent-detail")).toBeInTheDocument();
  });

  it("passes the org slug to the header so the Agents crumb stays org-scoped", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({
          orgSlug: "test-org",
          slug: "some-agent-slug",
        }),
      })
    );

    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "test-org" })
    );
  });

  it("passes the slug from params to AgentDetail", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({ orgSlug: "test-org", slug: "my-agent-uuid" }),
      })
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
      })
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
