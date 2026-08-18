import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "../mention-composer";

const mockUseOrganizationUsers = vi.fn();
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => mockUseOrganizationUsers(),
}));

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({
    data: [
      {
        id: "u-ada",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        avatarUrl: null,
        active: true,
      },
      {
        id: "u-grace",
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
        avatarUrl: null,
        active: true,
      },
      {
        id: "u-inactive",
        firstName: "Old",
        lastName: "Account",
        email: "old@example.com",
        avatarUrl: null,
        active: false,
      },
    ],
  });
});

describe("MentionComposer (FEA-3490)", () => {
  it("opens a filtered member picker on '@' and inserts the chosen mention", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MentionComposer onCancel={vi.fn()} onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.type(textarea, "hey @ad");

    // Only the matching, ACTIVE member shows.
    const list = await screen.findByTestId("mention-suggestions");
    expect(list).toHaveTextContent("Ada Lovelace");
    expect(list).not.toHaveTextContent("Grace Hopper");
    expect(list).not.toHaveTextContent("Old Account");

    await user.click(screen.getByText("Ada Lovelace"));

    // The token is replaced with the display name and the picker closes.
    expect((textarea as HTMLTextAreaElement).value).toBe("hey @Ada Lovelace ");
    expect(screen.queryByTestId("mention-suggestions")).not.toBeInTheDocument();

    await user.type(textarea, "take a look");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      body: "hey @Ada Lovelace take a look",
      mentions: ["u-ada"],
    });
  });

  it("drops a mention whose inserted label was deleted from the body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MentionComposer onCancel={vi.fn()} onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.type(textarea, "@ad");
    await user.click(await screen.findByText("Ada Lovelace"));
    // Wipe the body (removing the @Ada Lovelace token) and type fresh text.
    await user.clear(textarea);
    await user.type(textarea, "never mind");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledWith({
      body: "never mind",
      mentions: [],
    });
  });

  it("does not match a picked name as a prefix of a longer word", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    // Single-word display name so a prefix collision is possible.
    mockUseOrganizationUsers.mockReturnValue({
      data: [
        {
          id: "u-ada",
          firstName: "Ada",
          lastName: null,
          email: "ada@example.com",
          avatarUrl: null,
          active: true,
        },
      ],
    });
    render(<MentionComposer onCancel={vi.fn()} onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.type(textarea, "@ad");
    await user.click(await screen.findByText("Ada"));
    // Remove the inserted token and type a longer word that merely starts with
    // the name; the mention must NOT be resolved.
    await user.clear(textarea);
    await user.type(textarea, "@Adaline shipped it");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledWith({
      body: "@Adaline shipped it",
      mentions: [],
    });
  });

  it("submits with no mentions for a plain comment", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MentionComposer onCancel={vi.fn()} onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "just a note");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledWith({
      body: "just a note",
      mentions: [],
    });
  });

  it("opens an empty picker when the '@' toolbar button is clicked", async () => {
    const user = userEvent.setup();
    render(<MentionComposer onCancel={vi.fn()} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Mention" }));

    const list = await screen.findByTestId("mention-suggestions");
    // Empty query lists all active members.
    expect(list).toHaveTextContent("Ada Lovelace");
    expect(list).toHaveTextContent("Grace Hopper");
    expect(list).not.toHaveTextContent("Old Account");
  });

  it("portals the suggestion menu out of a clipping ancestor and positions it fixed", async () => {
    // Regression (FEA-3490): every comment surface mounts this composer inside a
    // scroll container whose `overflow` clips content (session-trace
    // `.sd3-scroll`, the comment rail). An in-flow absolutely-positioned dropdown
    // rendered outside that clip box was in the DOM but never painted — the
    // popover "never showed up". The menu must portal to <body> and be
    // `position: fixed` so no ancestor overflow can clip it.
    const user = userEvent.setup();
    render(
      <div data-testid="clipping-scroller" style={{ overflow: "hidden" }}>
        <MentionComposer onCancel={vi.fn()} onSubmit={vi.fn()} />
      </div>
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId("mention-suggestions");

    // Escaped the overflow-clipping ancestor: portaled directly onto <body>.
    const scroller = screen.getByTestId("clipping-scroller");
    expect(scroller).not.toContainElement(menu);
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed" });
    // Still fully functional from the portal (selection wires back to the composer).
    expect(menu).toHaveTextContent("Ada Lovelace");
  });

  it("ignores a Cmd/Ctrl+Enter submit while a post is already in flight", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MentionComposer isPending onCancel={vi.fn()} onSubmit={onSubmit} />
    );

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.type(textarea, "double submit");
    // The submit button is disabled by isPending; the keyboard shortcut must be
    // guarded too so a second submit cannot double-fire the mutation.
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("retains the draft when onSubmit rejects and clears it when it resolves", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    render(<MentionComposer onCancel={vi.fn()} onSubmit={onSubmit} />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.click(textarea);
    await user.type(textarea, "keep me");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    // Failed post keeps the draft for retry.
    await waitFor(() => expect(textarea.value).toBe("keep me"));

    // Retry succeeds; the draft clears only on resolution.
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
