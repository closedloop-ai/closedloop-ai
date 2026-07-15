import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import AgentsPage from "../page";

// UUID v4 sample used to confirm real-data wiring (UUID, not colon-slug)
const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";
const UUID_HREF_RE = /\/[^/]+\/agents\/[0-9a-f-]{36}$/;
const COLON_RE = /:/;

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

vi.mock(
  "@/app/(authenticated)/[orgSlug]/agents/components/agents-grouped-list-container",
  () => ({
    /**
     * Renders a sample link whose href uses the UUID `item.id` pattern
     * (`/${orgSlug}/agents/${item.id}`) — confirming the real-data wiring
     * (UUID, not colon-slug like "subagent:foo").
     */
    AgentsGroupedListContainer: () => (
      <ul>
        <li>
          <a href={`/test-org/agents/${TEST_UUID}`}>My Test Agent</a>
        </li>
      </ul>
    ),
  })
);

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

describe("AgentsPage (list route)", () => {
  it("wraps content in FeatureFlagged keyed on AGENTS_FEATURE_FLAG_KEY", () => {
    headerMock.mockImplementation(({ children }: { children?: ReactNode }) =>
      children ? (
        <div data-testid="header">{children}</div>
      ) : (
        <div data-testid="header" />
      )
    );

    render(<AgentsPage />);

    // The container is inside the FeatureFlagged gate
    const link = screen.getByRole("link", { name: "My Test Agent" });
    expect(link.closest("[data-feature-flag]")).toHaveAttribute(
      "data-feature-flag",
      AGENTS_FEATURE_FLAG_KEY
    );
  });

  it("list page links use UUID format, not colon-slug", () => {
    headerMock.mockImplementation(() => <div data-testid="header" />);

    render(<AgentsPage />);

    const link = screen.getByRole("link", { name: "My Test Agent" });
    expect(link).toHaveAttribute("href");
    const href = link.getAttribute("href") ?? "";
    expect(href).toMatch(UUID_HREF_RE);
    expect(href).not.toMatch(COLON_RE); // no colon-slug like "subagent:foo"
  });
});
