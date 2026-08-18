import { TeamRole } from "@repo/api/src/types/teams";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberRow } from "../member-row";
import type { TeamMemberDraft } from "../use-team-modal";

const REMOVE_LABEL = "Remove member";

function makeDraft(overrides: Partial<TeamMemberDraft> = {}): TeamMemberDraft {
  return {
    draftId: "draft-1",
    teamMemberId: "member-1",
    userId: "user-1",
    role: TeamRole.Member,
    user: {
      id: "user-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    ...overrides,
  };
}

describe("MemberRow remove control", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render a remove control on the viewer's own (self) row", () => {
    render(
      <MemberRow
        canManage={true}
        draft={makeDraft({ role: TeamRole.Owner })}
        isCurrentUser={true}
        onRemove={vi.fn()}
        onRoleChange={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: REMOVE_LABEL })
    ).not.toBeInTheDocument();
  });

  it('labels the viewer\'s own row with a muted "You"', () => {
    render(
      <MemberRow
        canManage={true}
        draft={makeDraft()}
        isCurrentUser={true}
        onRemove={vi.fn()}
        onRoleChange={vi.fn()}
      />
    );

    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it('does not label a non-self row with "You"', () => {
    render(
      <MemberRow
        canManage={true}
        draft={makeDraft({ userId: "user-2", draftId: "draft-2" })}
        isCurrentUser={false}
        onRemove={vi.fn()}
        onRoleChange={vi.fn()}
      />
    );

    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  it("does not render a remove control when the viewer cannot manage members", () => {
    render(
      <MemberRow
        canManage={false}
        draft={makeDraft()}
        isCurrentUser={false}
        onRemove={vi.fn()}
        onRoleChange={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: REMOVE_LABEL })
    ).not.toBeInTheDocument();
  });

  it("renders an active remove control for a manageable non-owner row", () => {
    render(
      <MemberRow
        canManage={true}
        draft={makeDraft({ userId: "user-2", draftId: "draft-2" })}
        isCurrentUser={false}
        onRemove={vi.fn()}
        onRoleChange={vi.fn()}
      />
    );

    const removeButton = screen.getByRole("button", { name: REMOVE_LABEL });
    expect(removeButton).toBeInTheDocument();
    expect(removeButton).toBeEnabled();
  });
});
