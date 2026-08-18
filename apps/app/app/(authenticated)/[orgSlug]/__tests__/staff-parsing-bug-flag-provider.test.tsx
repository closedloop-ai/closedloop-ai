import { useCanFlagParsingBug } from "@repo/app/agents/data-source/parsing-bug-flag-provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StaffParsingBugFlagProvider from "../staff-parsing-bug-flag-provider";

// FEA-4347: the web surface adapter resolves staff-ness from the Clerk user's
// email and injects it into the shared parsing-bug-flag context.
const mockUseUser = vi.fn();
vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
}));

function CanFlagProbe() {
  return <span data-testid="can-flag">{String(useCanFlagParsingBug())}</span>;
}

function renderWithUser(user: {
  loaded: boolean;
  email?: string;
}): string | null {
  mockUseUser.mockReturnValue({
    isLoaded: user.loaded,
    user: user.email
      ? { primaryEmailAddress: { emailAddress: user.email } }
      : null,
  });
  render(
    <StaffParsingBugFlagProvider>
      <CanFlagProbe />
    </StaffParsingBugFlagProvider>
  );
  return screen.getByTestId("can-flag").textContent;
}

afterEach(() => {
  cleanup();
  mockUseUser.mockReset();
});

describe("StaffParsingBugFlagProvider (web adapter, FEA-4347)", () => {
  it("enables the flag for a staff (@closedloop.ai) user", () => {
    expect(renderWithUser({ loaded: true, email: "dev@closedloop.ai" })).toBe(
      "true"
    );
  });

  it("disables the flag for a customer email", () => {
    expect(renderWithUser({ loaded: true, email: "user@acme.com" })).toBe(
      "false"
    );
  });

  it("stays disabled until identity has loaded", () => {
    expect(renderWithUser({ loaded: false, email: "dev@closedloop.ai" })).toBe(
      "false"
    );
  });

  it("stays disabled when there is no signed-in user", () => {
    expect(renderWithUser({ loaded: true })).toBe("false");
  });
});
