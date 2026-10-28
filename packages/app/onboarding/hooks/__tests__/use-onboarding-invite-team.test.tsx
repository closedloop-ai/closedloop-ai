// @vitest-environment jsdom

import { InviteMemberStatus } from "@repo/api/src/types/onboarding";
import { createWrapper } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOnboardingInviteTeam } from "../use-onboarding-invite-team";

const { mockApiClient } = vi.hoisted(() => ({
  mockApiClient: { post: vi.fn() },
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const EMAILS = ["a@example.com", "b@example.com"];
const LATER_EMAIL = "c@example.com";
const ACCOUNT_A = "user-a:org-a";
const ACCOUNT_B = "user-b:org-b";

/**
 * ISS-8348. The step above this hook renders its confirmation from the outcome,
 * so anything this misclassifies becomes a claim on screen.
 */
describe("useOnboardingInviteTeam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts idle and sends nothing on mount", () => {
    const { result } = renderHook(() => useOnboardingInviteTeam(ACCOUNT_A), {
      wrapper: createWrapper(),
    });

    expect(result.current.outcome).toEqual({ status: "idle" });
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it("posts the batch and reports a clean send", async () => {
    mockApiClient.post.mockResolvedValue({
      invited: 2,
      results: [
        { email: EMAILS[0], status: InviteMemberStatus.Invited },
        { email: EMAILS[1], status: InviteMemberStatus.Invited },
      ],
    });

    const { result } = renderHook(() => useOnboardingInviteTeam(ACCOUNT_A), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.invite(EMAILS);
    });

    // The production call really happened, with the addresses given.
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/organizations/invitations",
      expect.objectContaining({ emailAddresses: EMAILS })
    );
    expect(result.current.outcome).toEqual({ status: "sent", invited: 2 });
  });

  it("reports pending while the send is in flight", async () => {
    let release: ((value: unknown) => void) | undefined;
    mockApiClient.post.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const { result } = renderHook(() => useOnboardingInviteTeam(ACCOUNT_A), {
      wrapper: createWrapper(),
    });

    let inFlight: Promise<void> | undefined;
    act(() => {
      inFlight = result.current.invite(EMAILS);
    });

    await waitFor(() =>
      expect(result.current.outcome).toEqual({ status: "pending" })
    );
    release?.({ invited: 2, results: [] });
    await act(() => inFlight ?? Promise.resolve());
  });

  it("does not call a batch sent when addresses were already members", async () => {
    mockApiClient.post.mockResolvedValue({
      invited: 1,
      results: [
        { email: EMAILS[0], status: InviteMemberStatus.Invited },
        { email: EMAILS[1], status: InviteMemberStatus.AlreadyMember },
      ],
    });

    const { result } = renderHook(() => useOnboardingInviteTeam(ACCOUNT_A), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.invite(EMAILS);
    });

    expect(result.current.outcome).toEqual({
      alreadyMember: 1,
      failed: 0,
      invited: 1,
      status: "partial",
    });
  });

  it("reports a rejection as failed rather than leaving pending on screen", async () => {
    mockApiClient.post.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useOnboardingInviteTeam(ACCOUNT_A), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.invite(EMAILS);
    });

    expect(result.current.outcome).toEqual({
      failed: 0,
      message: "network down",
      status: "failed",
    });
  });
  /**
   * ISS-11670: the step lists these as the addresses this run invited, so only
   * rows the server reported `invited` may enter — never a typed address that
   * was already a member or failed — and a later send adds to the earlier one.
   */
  it("keeps only the addresses each send actually invited", async () => {
    mockApiClient.post
      .mockResolvedValueOnce({
        invited: 1,
        results: [
          { email: EMAILS[0], status: InviteMemberStatus.Invited },
          { email: EMAILS[1], status: InviteMemberStatus.AlreadyMember },
        ],
      })
      .mockResolvedValueOnce({
        invited: 1,
        results: [{ email: LATER_EMAIL, status: InviteMemberStatus.Invited }],
      })
      .mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useOnboardingInviteTeam(ACCOUNT_A), {
      wrapper: createWrapper(),
    });
    expect(result.current.invitedEmails).toEqual([]);

    await act(async () => {
      await result.current.invite(EMAILS);
    });
    expect(result.current.invitedEmails).toEqual([EMAILS[0]]);

    await act(async () => {
      await result.current.invite([LATER_EMAIL]);
    });
    await act(async () => {
      await result.current.invite(["failed@example.com"]);
    });
    expect(result.current.invitedEmails).toEqual([EMAILS[0], LATER_EMAIL]);
  });

  /**
   * ISS-11670 review: Desktop keeps the host mounted across sign-out and
   * organization switches, so this run's evidence must not follow the account.
   */
  it("drops the sent evidence when the identity changes", async () => {
    mockApiClient.post.mockResolvedValue({
      invited: 1,
      results: [{ email: EMAILS[0], status: InviteMemberStatus.Invited }],
    });

    const { result, rerender } = renderHook(
      ({ identity }: { identity: string | null }) =>
        useOnboardingInviteTeam(identity),
      { initialProps: { identity: ACCOUNT_A }, wrapper: createWrapper() }
    );
    await act(async () => {
      await result.current.invite([EMAILS[0]]);
    });
    expect(result.current.invitedEmails).toEqual([EMAILS[0]]);

    rerender({ identity: ACCOUNT_B });

    expect(result.current.invitedEmails).toEqual([]);
    expect(result.current.outcome).toEqual({ status: "idle" });
  });

  it("discards a send that answers after the identity changed", async () => {
    let release: ((value: unknown) => void) | undefined;
    mockApiClient.post.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const { result, rerender } = renderHook(
      ({ identity }: { identity: string | null }) =>
        useOnboardingInviteTeam(identity),
      { initialProps: { identity: ACCOUNT_A }, wrapper: createWrapper() }
    );
    let inFlight: Promise<void> | undefined;
    act(() => {
      inFlight = result.current.invite([EMAILS[0]]);
    });
    rerender({ identity: ACCOUNT_B });
    release?.({
      invited: 1,
      results: [{ email: EMAILS[0], status: InviteMemberStatus.Invited }],
    });
    await act(() => inFlight ?? Promise.resolve());

    expect(result.current.invitedEmails).toEqual([]);
    expect(result.current.outcome).toEqual({ status: "idle" });

    // Nor is it waiting to reappear if the first account comes back.
    rerender({ identity: ACCOUNT_A });
    expect(result.current.invitedEmails).toEqual([]);
    expect(result.current.outcome).toEqual({ status: "idle" });
  });
});
