import { ThreadStatus } from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  FULL_CAPABILITIES,
  makeComment,
  makeThread,
  READ_ONLY_CAPABILITIES,
  SESSION_THREADS,
} from "../comments-pane.fixtures";
import { PaneHost } from "../comments-pane.story-fixtures";
import {
  CommentsPaneLayout,
  CommentsPaneLoadStatus,
  NEW_THREAD_DRAFT_KEY,
  NO_ANCHOR_STATE_LABELS,
} from "../comments-pane-model";

const FLOW_TIMEOUT_MS = 20_000;

type HostProps = ComponentProps<typeof PaneHost>;

function hostProps(overrides: Partial<HostProps> = {}): HostProps {
  return {
    anchorStateLabels: NO_ANCHOR_STATE_LABELS,
    capabilities: FULL_CAPABILITIES,
    composerTarget: { anchor: { kind: CommentAnchorKind.Artifact } },
    layout: CommentsPaneLayout.Wide,
    loadStatus: CommentsPaneLoadStatus.Ready,
    onCreateThread: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onOpenChange: vi.fn(),
    onReopen: vi.fn(),
    onReply: vi.fn(),
    onResolve: vi.fn(),
    onRetrySync: vi.fn(),
    onSelectThread: vi.fn(),
    onWidthChange: vi.fn(),
    onWriteError: vi.fn(),
    open: true,
    threads: SESSION_THREADS,
    width: 360,
    ...overrides,
  };
}

function renderHost(overrides: Partial<HostProps> = {}) {
  const props = hostProps(overrides);
  const view = render(<PaneHost {...props} />);
  return { ...view, props };
}

const composer = () => screen.getByRole("textbox", { name: "Add a comment" });

/** Paste rather than type: per-key typing outlasts the test timeout on a loaded box. */
async function enter(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string
) {
  await user.click(field);
  await user.paste(text);
}

describe("CommentsPane composer", { timeout: FLOW_TIMEOUT_MS }, () => {
  it("keeps the draft across closing and reopening the rail", async () => {
    const user = userEvent.setup();
    renderHost();
    await enter(user, composer(), "half-written");

    await user.click(screen.getByRole("button", { name: "Close comments" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );

    expect(composer()).toHaveValue("half-written");
  });

  it("keeps the draft when the write fails, reports it, and clears it when one succeeds", async () => {
    const user = userEvent.setup();
    let fail = true;
    const onCreateThread = vi.fn(() =>
      fail ? Promise.reject(new Error("offline")) : Promise.resolve()
    );
    const { props } = renderHost({ onCreateThread });
    await enter(user, composer(), "keep me");

    await user.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(composer()).toBeEnabled());
    expect(composer()).toHaveValue("keep me");
    expect(props.onWriteError).toHaveBeenCalledWith({
      error: expect.any(Error),
      key: NEW_THREAD_DRAFT_KEY,
    });

    fail = false;
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(composer()).toHaveValue(""));
    expect(onCreateThread).toHaveBeenCalledTimes(2);
  });

  it("sends one write when two submits land in the same tick", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn(() => new Promise<void>(() => undefined));
    renderHost({ onCreateThread });
    await enter(user, composer(), "once");

    // Both fire before React re-renders, so only the ref guard can stop the second.
    act(() => {
      fireEvent.keyDown(composer(), { ctrlKey: true, key: "Enter" });
      fireEvent.keyDown(composer(), { ctrlKey: true, key: "Enter" });
    });

    expect(onCreateThread).toHaveBeenCalledExactlyOnceWith({
      anchor: { kind: CommentAnchorKind.Artifact },
      body: "once",
    });
  });

  it("holds a submit the host already knows is in flight", async () => {
    const user = userEvent.setup();
    const { props } = renderHost({ pendingDraftKeys: [NEW_THREAD_DRAFT_KEY] });
    await enter(user, composer(), "after remount");

    fireEvent.keyDown(composer(), { ctrlKey: true, key: "Enter" });

    expect(props.onCreateThread).not.toHaveBeenCalled();
  });

  it("drops a write that settles after the host moved to another entity", async () => {
    const user = userEvent.setup();
    let resolveWrite: () => void = () => undefined;
    const onCreateThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );
    const props = hostProps({ identity: "artifact-a", onCreateThread });
    const { rerender } = render(<PaneHost {...props} />);
    await enter(user, composer(), "for A");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    rerender(<PaneHost {...props} identity="artifact-b" />);
    expect(composer()).toBeEnabled();
    await enter(user, composer(), "for B");
    await act(async () => {
      resolveWrite();
      await Promise.resolve();
    });

    expect(composer()).toHaveValue("for B");
    expect(composer()).toBeEnabled();
  });

  it("drops a write from an earlier visit when the host comes back to the same entity", async () => {
    const user = userEvent.setup();
    let resolveWrite: () => void = () => undefined;
    const onCreateThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );
    const props = hostProps({ identity: "artifact-a", onCreateThread });
    const { rerender } = render(<PaneHost {...props} />);
    await enter(user, composer(), "first visit");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    // A → B → A: the identity VALUE matches the in-flight write's again, but
    // this is a new visit, so its draft and pending state are its own.
    rerender(<PaneHost {...props} identity="artifact-b" />);
    rerender(<PaneHost {...props} identity="artifact-a" />);
    await enter(user, composer(), "second visit");
    await act(async () => {
      resolveWrite();
      await Promise.resolve();
    });

    expect(composer()).toHaveValue("second visit");
    expect(composer()).toBeEnabled();
  });

  it("disables the composer and the filter while the read is loading", () => {
    const { rerender } = renderHost({
      loadStatus: CommentsPaneLoadStatus.Loading,
    });
    expect(composer()).toBeDisabled();
    expect(screen.getByRole("button", { name: "All" })).toBeDisabled();

    rerender(
      <PaneHost {...hostProps({ loadStatus: CommentsPaneLoadStatus.Ready })} />
    );
    expect(composer()).toBeEnabled();
    expect(screen.getByRole("button", { name: "All" })).toBeEnabled();
  });
});

describe("CommentsPane permissions", { timeout: FLOW_TIMEOUT_MS }, () => {
  const writeControls = [
    "Reply to comment",
    "Edit comment",
    "Delete thread",
    "Resolve comment",
  ];

  it("offers every write control to a viewer who has them", () => {
    renderHost();

    for (const name of writeControls) {
      expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
    }
    expect(composer()).toBeInTheDocument();
  });

  it("offers none to a read-only viewer, callbacks notwithstanding", () => {
    renderHost({ capabilities: READ_ONLY_CAPABILITIES });

    expect(
      screen.getByText("This step dominates the wall clock.")
    ).toBeInTheDocument();
    for (const name of writeControls) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("CommentsPane threads", { timeout: FLOW_TIMEOUT_MS }, () => {
  const ownThread = () => screen.getAllByRole("group")[0]!;

  it("saves an edit with the comment's revision", async () => {
    const user = userEvent.setup();
    const { props } = renderHost();

    await user.click(
      within(ownThread()).getByRole("button", { name: "Edit comment" })
    );
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    await user.clear(editor);
    await enter(user, editor, "Edited body");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const rootId = SESSION_THREADS[0]!.comments[0]!.id;
    expect(props.onEdit).toHaveBeenCalledExactlyOnceWith(rootId, {
      body: "Edited body",
      expectedRevision: 1,
    });
  });

  it("saves an edit against the revision it started from, across a refetch", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderHost();

    await user.click(
      within(ownThread()).getByRole("button", { name: "Edit comment" })
    );
    // A refetch lands mid-edit: someone else's edit moved the comment to 2.
    const [first, ...rest] = SESSION_THREADS;
    const [root, ...replies] = first!.comments;
    const refetched = [
      {
        ...first!,
        comments: [{ ...root!, body: "Their edit", revision: 2 }, ...replies],
      },
      ...rest,
    ];
    rerender(<PaneHost {...props} threads={refetched} />);
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    await user.clear(editor);
    await enter(user, editor, "My edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Still revision 1, so the API rejects the stale save instead of
    // silently overwriting "Their edit".
    expect(props.onEdit).toHaveBeenCalledExactlyOnceWith(root!.id, {
      body: "My edit",
      expectedRevision: 1,
    });
  });

  it("deletes once, and holds the control while the delete is in flight", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(() => new Promise<void>(() => undefined));
    renderHost({ onDelete });
    const remove = within(ownThread()).getByRole("button", {
      name: "Delete thread",
    });

    await user.click(remove);
    fireEvent.click(remove);

    expect(onDelete).toHaveBeenCalledExactlyOnceWith({
      commentId: SESSION_THREADS[0]!.comments[0]!.id,
      threadId: "session-thread-1",
    });
    expect(remove).toBeDisabled();
  });

  it("reports a rejected resolve and lets it be tried again", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(() => Promise.reject(new Error("conflict")));
    const { props } = renderHost({ onResolve });
    const resolve = within(ownThread()).getByRole("button", {
      name: "Resolve comment",
    });

    await user.click(resolve);

    await waitFor(() =>
      expect(props.onWriteError).toHaveBeenCalledWith({
        error: expect.any(Error),
        key: "resolve:session-thread-1",
      })
    );
    expect(resolve).toBeEnabled();
  });

  it("selects on Enter and Space but not from a control inside the card", async () => {
    const user = userEvent.setup();
    const { props } = renderHost();

    fireEvent.keyDown(ownThread(), { key: " " });
    expect(props.onSelectThread).toHaveBeenLastCalledWith("session-thread-1");
    fireEvent.keyDown(screen.getAllByRole("group")[1]!, { key: "Enter" });
    expect(props.onSelectThread).toHaveBeenLastCalledWith("session-thread-2");

    vi.mocked(props.onSelectThread!).mockClear();
    await user.click(
      within(ownThread()).getByRole("button", { name: "Reply to comment" })
    );
    expect(props.onSelectThread).not.toHaveBeenCalled();
  });

  it("discards a reply on Cancel, and reopens a kept reply draft after the rail closes", async () => {
    const user = userEvent.setup();
    renderHost();
    const openReply = () =>
      user.click(
        within(ownThread()).getByRole("button", { name: "Reply to comment" })
      );

    await openReply();
    await enter(
      user,
      screen.getByRole("textbox", { name: "Reply to comment" }),
      "kept"
    );
    await user.click(screen.getByRole("button", { name: "Close comments" }));
    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );
    expect(
      screen.getByRole("textbox", { name: "Reply to comment" })
    ).toHaveValue("kept");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("textbox", { name: "Reply to comment" })
    ).toBeNull();
    await openReply();
    expect(
      screen.getByRole("textbox", { name: "Reply to comment" })
    ).toHaveValue("");
  });

  it("hides resolved threads under the Open filter and says so when nothing matches", async () => {
    const user = userEvent.setup();
    const resolved = makeThread({
      id: "resolved-1",
      status: ThreadStatus.Resolved,
    });
    const chooseOpen = async () => {
      await user.click(screen.getByRole("button", { name: "All" }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Open comments" })
      );
    };
    const { rerender } = renderHost({
      threads: [makeThread({ id: "open-1" }), resolved],
    });

    await chooseOpen();
    expect(screen.getByText("Body of open-1")).toBeInTheDocument();
    expect(screen.queryByText("Body of resolved-1")).toBeNull();
    expect(screen.queryByText("No comments in this view")).toBeNull();

    rerender(<PaneHost {...hostProps({ threads: [resolved] })} />);
    expect(screen.getByText("No comments in this view")).toBeInTheDocument();
  });

  it("falls back to All when the host's capabilities stop offering the chosen filter", async () => {
    const user = userEvent.setup();
    const threads = [makeThread({ id: "trace-1" })];
    const { rerender } = renderHost({ threads });

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Code comments" })
    );
    expect(screen.queryByText("Body of trace-1")).toBeNull();

    // Same pane instance, new capabilities: the prototype's Artifact → Sessions.
    rerender(
      <PaneHost
        {...hostProps({
          capabilities: {
            ...FULL_CAPABILITIES,
            anchorKinds: [CommentAnchorKind.Trace],
          },
          threads,
        })}
      />
    );
    expect(screen.getByText("Body of trace-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
  });
});

describe("CommentsPane rail", { timeout: FLOW_TIMEOUT_MS }, () => {
  it.each([
    ["ArrowLeft", 552, 560],
    ["ArrowRight", 288, 280],
    ["End", 300, 560],
    ["Home", 500, 280],
  ])("keeps %s from %ipx inside the bounds", (key, width, expected) => {
    const { props } = renderHost({ width });

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize comments rail" }),
      { key }
    );

    expect(props.onWidthChange).toHaveBeenLastCalledWith(expected);
  });

  it("caps both bounds at a container narrower than the minimum", () => {
    const { props } = renderHost({ availableWidth: 240, width: 360 });
    const handle = screen.getByRole("separator", {
      name: "Resize comments rail",
    });
    expect(handle).toHaveAttribute("aria-valuenow", "240");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(props.onWidthChange).toHaveBeenLastCalledWith(240);
  });

  it("keeps pointer resizing inside the bounds and stops after release", () => {
    const { props } = renderHost({ width: 360 });
    fireEvent.pointerDown(
      screen.getByRole("separator", { name: "Resize comments rail" }),
      { clientX: 500 }
    );

    fireEvent.pointerMove(window, { clientX: 0 });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(560);
    fireEvent.pointerMove(window, { clientX: 900 });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(280);
    fireEvent.pointerUp(window);
    const calls = vi.mocked(props.onWidthChange).mock.calls.length;
    fireEvent.pointerMove(window, { clientX: 100 });
    expect(props.onWidthChange).toHaveBeenCalledTimes(calls);
  });

  it("dismisses on Escape outside a field and gives focus back to the toggle", () => {
    const { props } = renderHost();

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize comments rail" }),
      { key: "Escape" }
    );

    expect(screen.queryByRole("complementary")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show comments rail" })
    ).toHaveFocus();
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("returns focus to the toggle from the header close button", async () => {
    const user = userEvent.setup();
    renderHost();

    await user.click(screen.getByRole("button", { name: "Close comments" }));

    expect(
      screen.getByRole("button", { name: "Show comments rail" })
    ).toHaveFocus();
  });

  it("keeps the rail open on Escape typed into the new-thread composer, or mid-composition", () => {
    renderHost();

    fireEvent.keyDown(composer(), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("separator"), {
      isComposing: true,
      key: "Escape",
    });

    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("cancels a reply on Escape without closing the rail", async () => {
    const user = userEvent.setup();
    renderHost();
    await user.click(
      screen.getAllByRole("button", { name: "Reply to comment" })[0]!
    );
    await enter(
      user,
      screen.getByRole("textbox", { name: "Reply to comment" }),
      "drop me"
    );

    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("textbox", { name: "Reply to comment" })
    ).toBeNull();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("closes only the filter menu on Escape", async () => {
    const user = userEvent.setup();
    renderHost();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(
      await screen.findByRole("menuitem", { name: "Open comments" })
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("shows one close control in the narrow Sheet", async () => {
    renderHost({ layout: CommentsPaneLayout.Narrow });

    const sheet = await screen.findByRole("dialog", { name: "Comments" });

    expect(within(sheet).getAllByRole("button", { name: CLOSE_NAME })).toEqual([
      within(sheet).getByRole("button", { name: "Close comments" }),
    ]);
  });
});

const CLOSE_NAME = /^Close/;

describe("CommentsPane load states", { timeout: FLOW_TIMEOUT_MS }, () => {
  it("shows a failed read as an alert, never as an empty list", () => {
    renderHost({ loadStatus: CommentsPaneLoadStatus.Error, threads: [] });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Comments are unavailable in this view."
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Comments Unavailable"
    );
    expect(screen.queryByText("No comments in this view")).toBeNull();
  });

  it("shows an empty read as empty", () => {
    renderHost({ threads: [] });

    expect(screen.getByText("No comments in this view")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets only the note speak for an empty partial read", () => {
    renderHost({
      loadStatus: CommentsPaneLoadStatus.Partial,
      notice: "Fixture: coverage note",
      threads: [],
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Fixture: coverage note"
    );
    expect(screen.queryByText("No comments in this view")).toBeNull();
  });

  it("names a comment's missing author with the shared fallback", () => {
    renderHost({
      threads: [
        makeThread({
          comments: [
            makeComment({
              author: { avatarUrl: null, id: "gone", name: null },
              body: "orphan author",
              threadId: "t",
            }),
          ],
          id: "t",
        }),
      ],
    });

    expect(screen.getByText("Unknown user")).toBeInTheDocument();
  });
});
