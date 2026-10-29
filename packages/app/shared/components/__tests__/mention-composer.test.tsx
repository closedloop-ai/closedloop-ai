import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "../mention-composer";

const mockUseOrganizationUsers = vi.fn();

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
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );

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
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );

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
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );

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
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );

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
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

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
        <MentionComposer
          members={mockUseOrganizationUsers().data}
          onCancel={vi.fn()}
          onSubmit={vi.fn()}
        />
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

  // PLN-2189 T-2.8: the list moved to `mention-suggestion-list.tsx`; the
  // composer's menu is unchanged by the editor picker's listbox mode.
  it("keeps its menu as plain member buttons sized to the textarea", async () => {
    const user = userEvent.setup();
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Mention" }));
    const menu = await screen.findByTestId("mention-suggestions");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(
      within(menu)
        .getAllByRole("button")
        .map((row) => row.textContent)
    ).toEqual([
      // One initial on every avatar (Nerys, 2026-10-22).
      "AAda Lovelaceada@example.com",
      "GGrace Hoppergrace@example.com",
    ]);
    const textareaWidth = screen
      .getByRole("textbox")
      .getBoundingClientRect().width;
    expect(menu.style.width).toBe(`${textareaWidth}px`);
  });

  it("ignores a Cmd/Ctrl+Enter submit while a post is already in flight", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MentionComposer
        isPending
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
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
    render(
      <MentionComposer
        members={mockUseOrganizationUsers().data}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );

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

  it("leaves a controlled draft to its owner after a submit (PLN-2162 decision 4)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    function Owner() {
      const [value, setValue] = useState("");
      return (
        <MentionComposer
          members={mockUseOrganizationUsers().data}
          onSubmit={onSubmit}
          onValueChange={setValue}
          value={value}
        />
      );
    }
    render(<Owner />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.click(textarea);
    await user.type(textarea, "owner keeps this");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      body: "owner keeps this",
      mentions: [],
    });
    expect(textarea.value).toBe("owner keeps this");
  });

  it("carries no picked mention past a controlled draft its owner cleared", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    function Owner() {
      const [value, setValue] = useState("");
      return (
        <MentionComposer
          members={mockUseOrganizationUsers().data}
          onSubmit={(payload) => {
            onSubmit(payload);
            setValue("");
          }}
          onValueChange={setValue}
          value={value}
        />
      );
    }
    render(<Owner />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.type(textarea, "@ad");
    await user.click(await screen.findByText("Ada Lovelace"));
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.type(textarea, "@Ada Lovelace again");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit.mock.calls.map(([payload]) => payload.mentions)).toEqual([
      ["u-ada"],
      [],
    ]);
  });

  it("keeps a controlled draft's picks while its owner keeps the text", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    function Owner() {
      const [value, setValue] = useState("");
      return (
        <MentionComposer
          members={mockUseOrganizationUsers().data}
          onSubmit={onSubmit}
          onValueChange={setValue}
          value={value}
        />
      );
    }
    render(<Owner />);

    const textarea = screen.getByRole("textbox");
    await user.click(textarea);
    await user.type(textarea, "@ad");
    await user.click(await screen.findByText("Ada Lovelace"));
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit.mock.calls.map(([payload]) => payload.mentions)).toEqual([
      ["u-ada"],
      ["u-ada"],
    ]);
  });
});
