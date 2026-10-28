import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { InboxBadge } from "../inbox-badge";

const mockUseLiveblocksAvailability = vi.fn();
const mockUseUnreadInboxNotificationsCount = vi.fn();

vi.mock("@repo/collaboration/client/liveblocks-error-boundary", () => ({
  useLiveblocksAvailability: () => mockUseLiveblocksAvailability(),
}));

vi.mock("@repo/collaboration/client/hooks", () => ({
  useUnreadInboxNotificationsCount: () =>
    mockUseUnreadInboxNotificationsCount(),
}));

vi.mock("@liveblocks/react/suspense", () => ({
  ClientSideSuspense: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

describe("InboxBadge", () => {
  it("renders nothing when Liveblocks is not available", () => {
    mockUseLiveblocksAvailability.mockReturnValue({ isAvailable: false });
    mockUseUnreadInboxNotificationsCount.mockReturnValue({ count: 5 });

    const { container } = render(<InboxBadge />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the unread count is zero", () => {
    mockUseLiveblocksAvailability.mockReturnValue({ isAvailable: true });
    mockUseUnreadInboxNotificationsCount.mockReturnValue({ count: 0 });

    const { container } = render(<InboxBadge />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the count badge when there are unread notifications", () => {
    mockUseLiveblocksAvailability.mockReturnValue({ isAvailable: true });
    mockUseUnreadInboxNotificationsCount.mockReturnValue({ count: 5 });

    render(<InboxBadge />);

    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
