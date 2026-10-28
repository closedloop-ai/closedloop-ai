import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCommentsPaneDrafts } from "../../../../comments/use-comments-pane-drafts";
import { genericArtifacts } from "../../fixtures";
import {
  ArtifactCommentsRail,
  type GenericCommentRecord,
} from "../artifact-comments-rail";
import { FLOW_TIMEOUT_MS } from "./support/flow-timeouts";

const artifact = genericArtifacts[0]!;

type RailProps = ComponentProps<typeof ArtifactCommentsRail>;

function record(
  overrides: Partial<GenericCommentRecord> & { id: string }
): GenericCommentRecord {
  return {
    author: "Pascoe Birchall",
    body: `Body of ${overrides.id}`,
    context: "",
    time: "5 min ago",
    ...overrides,
  };
}

/** Owns the fixture arrays and drafts the way the detail shell does. */
function Harness({
  initialGeneral = [],
  initialSessions = [],
  onGeneral,
  ...overrides
}: Partial<RailProps> & {
  initialGeneral?: GenericCommentRecord[];
  initialSessions?: GenericCommentRecord[];
  onGeneral?: (records: GenericCommentRecord[]) => void;
}) {
  const [general, setGeneral] = useState(initialGeneral);
  const [sessions, setSessions] = useState(initialSessions);
  const drafts = useCommentsPaneDrafts(artifact.id);
  return (
    <ArtifactCommentsRail
      activeTab="artifact"
      artifact={artifact}
      availableWidth={800}
      layout="wide"
      onOpenChange={() => undefined}
      onSelectSessionComment={() => undefined}
      onWidthChange={() => undefined}
      open
      width={352}
      {...drafts}
      {...overrides}
      generalComments={general}
      sessionComments={sessions}
      setGeneralComments={(update) =>
        setGeneral((current) => {
          const next = typeof update === "function" ? update(current) : update;
          onGeneral?.(next);
          return next;
        })
      }
      setSessionComments={setSessions}
    />
  );
}

describe("ArtifactCommentsRail on the canonical pane", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("files an artifact-wide comment by the prototype viewer", async () => {
    const user = userEvent.setup();
    const onGeneral = vi.fn();
    render(<Harness onGeneral={onGeneral} />);

    await user.type(
      screen.getByRole("textbox", { name: "Add a comment" }),
      "New note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onGeneral).toHaveBeenLastCalledWith([
      expect.objectContaining({
        anchor: { kind: CommentAnchorKind.Artifact },
        author: "Ottilie Eastwick",
        body: "New note",
      }),
    ]);
    expect(screen.getByText("New note")).toBeInTheDocument();
  });

  it("anchors a requested draft to its content quote, once per nonce", async () => {
    const user = userEvent.setup();
    const onGeneral = vi.fn();
    const request = {
      anchorPreview: "the quote",
      commentId: "req-1",
      nonce: 1,
    };
    const { rerender } = render(
      <Harness draftRequest={request} onGeneral={onGeneral} />
    );

    expect(screen.getByText("Commenting on “the quote”")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Comment on “the quote”" }),
      "On the quote"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(onGeneral).toHaveBeenLastCalledWith([
      expect.objectContaining({
        anchor: { kind: CommentAnchorKind.Text },
        anchorPreview: "the quote",
        id: "req-1",
      }),
    ]);

    rerender(<Harness draftRequest={{ ...request }} onGeneral={onGeneral} />);
    expect(screen.queryByText("Commenting on “the quote”")).toBeNull();
  });

  it("threads a reply under its parent", async () => {
    const user = userEvent.setup();
    const onGeneral = vi.fn();
    render(
      <Harness initialGeneral={[record({ id: "c1" })]} onGeneral={onGeneral} />
    );

    await user.click(screen.getByRole("button", { name: "Reply to comment" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reply to comment" }),
      "Agreed"
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));

    expect(onGeneral).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "c1" }),
      expect.objectContaining({ body: "Agreed", parentId: "c1" }),
    ]);
    expect(
      screen.queryByRole("textbox", { name: "Reply to comment" })
    ).toBeNull();
  });

  it("toggles a thread between resolved and open", async () => {
    const user = userEvent.setup();
    const onGeneral = vi.fn();
    render(
      <Harness initialGeneral={[record({ id: "c1" })]} onGeneral={onGeneral} />
    );

    await user.click(screen.getByRole("button", { name: "Resolve comment" }));
    expect(onGeneral).toHaveBeenLastCalledWith([
      expect.objectContaining({ status: "resolved" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Reopen comment" }));
    expect(onGeneral).toHaveBeenLastCalledWith([
      expect.objectContaining({ status: "open" }),
    ]);
  });

  it("lets only the viewer edit their own comment", () => {
    render(
      <Harness
        initialGeneral={[
          record({ author: "Ottilie Eastwick", id: "mine" }),
          record({ id: "theirs" }),
        ]}
      />
    );

    expect(
      screen.getAllByRole("button", { name: "Edit comment" })
    ).toHaveLength(1);
  });

  it("jumps to a session comment's trace row and waits for a trace selection to comment", async () => {
    const user = userEvent.setup();
    const onSelectSessionComment = vi.fn();
    render(
      <Harness
        activeTab="sessions"
        initialSessions={[
          record({
            anchorPreview: "the row",
            id: "s1",
            traceRow: 7,
          }),
        ]}
        onSelectSessionComment={onSelectSessionComment}
      />
    );

    await user.click(screen.getByText("Body of s1"));

    expect(onSelectSessionComment).toHaveBeenCalledExactlyOnceWith("s1", 7);
    expect(
      screen.getByText(
        "Select an eligible trace row or range to add a comment."
      )
    ).toBeInTheDocument();
  });

  it("selects the thread a selection request names", () => {
    render(
      <Harness
        initialGeneral={[record({ id: "c1" }), record({ id: "c2" })]}
        selectionRequest={{ commentId: "c2", nonce: 1 }}
      />
    );

    const selected = screen
      .getAllByRole("group")
      .filter((group) => group.getAttribute("aria-current") === "true");
    expect(selected).toHaveLength(1);
    expect(within(selected[0]!).getByText("Body of c2")).toBeInTheDocument();
  });

  it("scrolls a later selection request into view", () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const threads = [record({ id: "c1" }), record({ id: "c2" })];
    const { rerender } = render(
      <Harness
        initialGeneral={threads}
        selectionRequest={{ commentId: "c1", nonce: 1 }}
      />
    );
    scroll.mockClear();

    rerender(
      <Harness
        initialGeneral={threads}
        selectionRequest={{ commentId: "c2", nonce: 2 }}
      />
    );

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toHaveTextContent("Body of c2");
    scroll.mockRestore();
  });

  it("ignores a selection request on the sessions tab", () => {
    render(
      <Harness
        activeTab="sessions"
        initialSessions={[record({ id: "s1", traceRow: 1 })]}
        selectionRequest={{ commentId: "s1", nonce: 1 }}
      />
    );

    expect(screen.getByText("Body of s1")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("group")
        .filter((group) => group.getAttribute("aria-current") === "true")
    ).toHaveLength(0);
  });

  it("applies a draft request made while closed once the rail opens, never on the sessions tab", () => {
    const request = { anchorPreview: "the quote", commentId: "q", nonce: 1 };
    const { rerender } = render(
      <Harness activeTab="sessions" draftRequest={request} open />
    );
    expect(screen.queryByText("Commenting on “the quote”")).toBeNull();

    rerender(<Harness draftRequest={request} open={false} />);
    expect(screen.queryByText("Commenting on “the quote”")).toBeNull();
    rerender(<Harness draftRequest={request} open />);
    expect(screen.getByText("Commenting on “the quote”")).toBeInTheDocument();
  });
});
