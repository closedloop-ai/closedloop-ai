import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteTeamDialog } from "../invite-team-dialog";

const SEND_ONE_INVITATION_REGEX = /Send 1 invitation/i;
const ADD_ANOTHER_REGEX = /Add another/i;

const { mockApiClient, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockApiClient: { post: vi.fn() },
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderDialog() {
  return render(
    <InviteTeamDialog trigger={<button type="button">Invite</button>} />,
    {
      wrapper: createWrapper(),
    }
  );
}

describe("InviteTeamDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens from the trigger and posts entered emails to the invitations route", async () => {
    mockApiClient.post.mockResolvedValue({
      invited: 1,
      results: [
        {
          email: "teammate@example.com",
          invitationId: "inv_1",
          status: "invited",
        },
      ],
    });

    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    const input = await screen.findByLabelText("Email address");
    fireEvent.change(input, { target: { value: "teammate@example.com" } });

    fireEvent.click(
      screen.getByRole("button", { name: SEND_ONE_INVITATION_REGEX })
    );

    await waitFor(() =>
      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/organizations/invitations",
        {
          emailAddresses: ["teammate@example.com"],
          role: "org:member",
        }
      )
    );
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it("blocks the batch and does not call the route when any email is invalid", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    // One valid email keeps the Send button enabled; a second invalid email
    // must abort the whole batch with an error rather than partially inviting.
    const firstInput = await screen.findByLabelText("Email address");
    fireEvent.change(firstInput, { target: { value: "valid@example.com" } });

    fireEvent.click(screen.getByRole("button", { name: ADD_ANOTHER_REGEX }));

    const inputs = await screen.findAllByLabelText("Email address");
    fireEvent.change(inputs[1], { target: { value: "not-an-email" } });

    fireEvent.click(
      screen.getByRole("button", { name: SEND_ONE_INVITATION_REGEX })
    );

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it("surfaces per-email failures and does not show success when the route reports a failed invite", async () => {
    // The route returns 200 even when Clerk rejects an email (per-email
    // `status: "failed"`, `invited: 0`). The dialog must not blindly toast
    // success + close; it should surface the failure.
    mockApiClient.post.mockResolvedValue({
      invited: 0,
      results: [
        {
          email: "teammate@example.com",
          status: "failed",
          reason: "Clerk rejected the address",
        },
      ],
    });

    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    const input = await screen.findByLabelText("Email address");
    fireEvent.change(input, { target: { value: "teammate@example.com" } });

    fireEvent.click(
      screen.getByRole("button", { name: SEND_ONE_INVITATION_REGEX })
    );

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("teammate@example.com")
      )
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
    // The dialog stays open (email row not reset) so the user can retry.
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "teammate@example.com"
    );
  });
});
