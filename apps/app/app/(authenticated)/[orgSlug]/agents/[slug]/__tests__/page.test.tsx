import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "../page";

const { headerMock } = vi.hoisted(() => ({
  headerMock: vi.fn(),
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("@repo/app/agents/components/workspace/agent-detail", () => ({
  AgentDetail: ({ slug }: { slug: string }) => (
    <div data-slug={slug} data-testid="agent-detail" />
  ),
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

describe("AgentDetailPage (detail route)", () => {
  beforeEach(() => {
    headerMock.mockReset();
    headerMock.mockImplementation(() => <div data-testid="header" />);
  });

  it("wraps AgentDetail in FeatureFlagged keyed on AGENTS_FEATURE_FLAG_KEY", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({
          orgSlug: "test-org",
          slug: "some-agent-slug",
        }),
      })
    );

    expect(
      screen.getByTestId("agent-detail").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", AGENTS_FEATURE_FLAG_KEY);
  });

  it("breadcrumb 'Agents' link targets /<orgSlug>/agents", async () => {
    render(
      await AgentDetailPage({
        params: Promise.resolve({
          orgSlug: "test-org",
          slug: "some-agent-slug",
        }),
      })
    );

    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        breadcrumbs: expect.arrayContaining([
          { label: "Agents", href: "/test-org/agents" },
        ]),
      }),
      undefined
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
});
