import { stubResizableContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericArtifactDetailShell } from "../generic-artifact-detail-shell";
import {
  ACTIVITY_PANEL,
  commentsLayoutMode,
  commentsRail,
  lightPanels,
  otherShellArtifact,
  ShellHarness,
  shellArtifact,
} from "./support/detail-shell-harness";
import { FLOW_TIMEOUT_MS } from "./support/flow-timeouts";

const artifact = shellArtifact;
const otherArtifact = otherShellArtifact;
const SEEDED_SHELL_BODY =
  "The comments rail remains consistent while the center viewer or editor changes by artifact type.";
const SEEDED_SESSION_BODY =
  "The revision session accounts for most of the rework cost in this trace.";

let widthStub: ReturnType<typeof stubResizableContainerWidthPx>;

function setShellWidth(width: number) {
  widthStub.restore();
  widthStub = stubResizableContainerWidthPx(width);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, width, 600)
  );
}

beforeEach(() => {
  widthStub = stubResizableContainerWidthPx(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1200, 600)
  );
});

afterEach(() => {
  widthStub.restore();
  vi.restoreAllMocks();
});

describe("GenericArtifactDetailShell tabs", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("opens on the first listed tab and hides the rail on Details", () => {
    // Open, so only the Details suppression can keep the rail off screen.
    render(<ShellHarness initialOpen tabs={["details", "artifact"]} />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Details",
      "Artifact",
    ]);
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("Details panel")).toBeInTheDocument();
    expect(commentsRail()).toBeNull();
  });

  it("renders no tab and no panel when no tabs are listed", () => {
    render(<ShellHarness tabs={[]} />);

    // ISS-10790: a tab the type does not list renders nothing at all, so an
    // empty list renders an empty frame rather than an unlisted Artifact tab.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryAllByRole("tabpanel")).toHaveLength(0);
    expect(screen.queryByText("[Artifact Canvas]")).toBeNull();
  });

  it("falls back to the first listed tab for an initial tab that is not listed", () => {
    render(
      <ShellHarness initialTab="activity" tabs={["artifact", "details"]} />
    );

    // ISS-10790 AC 2: an unlisted tab is never revealed; the shell shows the
    // first configured tab, selected. (Before the shared shell, the unlisted
    // panel showed with no tab selected.)
    expect(screen.queryByText(ACTIVITY_PANEL)).toBeNull();
    expect(screen.getByRole("tab", { name: "Artifact" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("passes the page's canvas state through to the Artifact tab", () => {
    // ISS-10791: the tab owns the canvas lifecycle even when a real canvas is
    // supplied, so an adapter can show permission instead of the canvas.
    render(
      <ShellHarness
        panels={{ artifact: <p>real canvas</p> }}
        presentation={{
          canvas: {
            permission: {
              description: "Fixture: permission description",
              title: "Fixture: permission title",
            },
            state: "permission",
          },
        }}
        tabs={["artifact", "details"]}
      />
    );

    expect(screen.getByText("Fixture: permission title")).toBeVisible();
    expect(screen.queryByText("real canvas")).not.toBeInTheDocument();
  });

  it("follows a later initialTab change", () => {
    const { rerender } = render(<ShellHarness initialTab="artifact" />);
    expect(screen.getByText("[Artifact Canvas]")).toBeInTheDocument();

    rerender(<ShellHarness initialTab="sessions" />);

    expect(screen.getByText("Sessions panel")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("reports tab changes and ignores a click on the active tab", async () => {
    const user = userEvent.setup();
    const onActiveTabChange = vi.fn();
    const onCommentsOpenChange = vi.fn();
    render(
      <ShellHarness
        initialOpen
        onActiveTabChange={onActiveTabChange}
        onCommentsOpenChange={onCommentsOpenChange}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Artifact" }));
    expect(onActiveTabChange).not.toHaveBeenCalled();
    expect(onCommentsOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(onActiveTabChange).toHaveBeenCalledExactlyOnceWith("details");
    expect(onCommentsOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(commentsRail()).toBeNull();
  });

  it("never reopens the rail on Details after a round trip from an open tab", async () => {
    const user = userEvent.setup();
    const onCommentsOpenChange = vi.fn();
    render(
      <ShellHarness
        initialOpen
        initialTab="details"
        onCommentsOpenChange={onCommentsOpenChange}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Artifact" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("tab", { name: "Details" }));

    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(false);
    expect(commentsRail()).toBeNull();
  });

  it("remembers whether the rail was open on each tab", async () => {
    const user = userEvent.setup();
    const onCommentsOpenChange = vi.fn();
    render(
      <ShellHarness initialOpen onCommentsOpenChange={onCommentsOpenChange} />
    );

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Open rail" }));
    expect(
      screen.getByRole("complementary", { name: "Session comments" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Artifact" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Close comments" }));

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole("tab", { name: "Artifact" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe("GenericArtifactDetailShell layout", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("keeps an open rail open at a wide width", () => {
    const onCommentsOpenChange = vi.fn();
    render(
      <ShellHarness initialOpen onCommentsOpenChange={onCommentsOpenChange} />
    );

    expect(commentsLayoutMode()).toBe("wide");
    expect(onCommentsOpenChange).not.toHaveBeenCalled();
    expect(commentsRail()).toHaveStyle({ width: "352px" });
  });

  it("collapses an open rail each time the shell narrows into a tighter mode", () => {
    const onCommentsOpenChange = vi.fn();
    render(
      <GenericArtifactDetailShell
        artifact={artifact}
        commentsOpen
        onCommentsOpenChange={onCommentsOpenChange}
        panels={lightPanels}
      />
    );

    act(() => widthStub.setWidth(900));
    expect(commentsLayoutMode()).toBe("compact");
    expect(onCommentsOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    act(() => widthStub.setWidth(1000));
    expect(onCommentsOpenChange).toHaveBeenCalledTimes(1);
    act(() => widthStub.setWidth(500));
    expect(commentsLayoutMode()).toBe("mobile");
    expect(onCommentsOpenChange).toHaveBeenCalledTimes(2);
    act(() => widthStub.setWidth(900));
    expect(onCommentsOpenChange).toHaveBeenCalledTimes(2);
  });

  it("does not collapse a closed rail when the shell narrows", () => {
    const onCommentsOpenChange = vi.fn();
    render(<ShellHarness onCommentsOpenChange={onCommentsOpenChange} />);

    act(() => widthStub.setWidth(500));

    expect(commentsLayoutMode()).toBe("mobile");
    expect(onCommentsOpenChange).not.toHaveBeenCalled();
  });

  it("collapses a rail that mounts open in a compact shell", () => {
    setShellWidth(400);
    const onCommentsOpenChange = vi.fn();
    render(
      <ShellHarness initialOpen onCommentsOpenChange={onCommentsOpenChange} />
    );

    expect(commentsLayoutMode()).toBe("mobile");
    expect(onCommentsOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    [900, "right-0"],
    [500, "bottom-0"],
  ])(
    "opens the rail as a %ipx shell's sheet instead of an inline rail",
    async (width, edge) => {
      const user = userEvent.setup();
      setShellWidth(width);
      render(<ShellHarness />);

      await user.click(screen.getByRole("button", { name: "Open rail" }));

      // ISS-11209: below 1025px the canonical pane is a Sheet, never a squeezed rail.
      const sheet = await screen.findByRole("dialog", { name: "Comments" });
      expect(sheet).toHaveClass(edge);
      expect(commentsRail()).toBeNull();
    }
  );
});

describe("GenericArtifactDetailShell comments", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("seeds default artifact and session threads", async () => {
    const user = userEvent.setup();
    const onSelectSessionComment = vi.fn();
    render(
      <ShellHarness
        initialOpen
        onSelectSessionComment={onSelectSessionComment}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Comments 2" })
    ).toBeInTheDocument();
    expect(screen.getByText(SEEDED_SHELL_BODY)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    await user.click(screen.getByRole("button", { name: "Open rail" }));
    await user.click(screen.getByText(SEEDED_SESSION_BODY));

    expect(onSelectSessionComment).toHaveBeenCalledExactlyOnceWith(
      "session-comment-1",
      4
    );
  });

  it("replaces the defaults with supplied initial comments", async () => {
    const user = userEvent.setup();
    render(
      <ShellHarness
        initialComments={{
          artifact: [
            {
              author: "Sam Chen",
              body: "Supplied artifact note",
              context: "",
              id: "a1",
              time: "now",
            },
          ],
          sessions: [],
        }}
        initialOpen
      />
    );

    expect(screen.getByText("Supplied artifact note")).toBeInTheDocument();
    expect(screen.queryByText(SEEDED_SHELL_BODY)).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    await user.click(screen.getByRole("button", { name: "Open rail" }));
    expect(
      screen.getByRole("heading", { name: "Session comments 0" })
    ).toBeInTheDocument();
  });

  it("forwards the rail presentation config", () => {
    render(
      <ShellHarness
        initialOpen
        presentation={{ comments: { artifactTitle: "Review notes" } }}
      />
    );

    expect(
      screen.getByRole("complementary", { name: "Review notes" })
    ).toBeInTheDocument();
  });
});

describe("GenericArtifactDetailShell artifact identity change", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("keeps the tab and per-tab rail memory but starts the next artifact's draft empty", async () => {
    const user = userEvent.setup();
    const onCommentsOpenChange = vi.fn();
    const { rerender } = render(
      <ShellHarness
        artifact={artifact}
        initialOpen
        onCommentsOpenChange={onCommentsOpenChange}
      />
    );
    await user.type(
      screen.getByRole("textbox", { name: "Add a comment" }),
      "unsent"
    );
    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    await user.click(screen.getByRole("tab", { name: "Artifact" }));
    // The draft outlived the round trip through a tab with its rail closed.
    expect(screen.getByRole("textbox", { name: "Add a comment" })).toHaveValue(
      "unsent"
    );

    rerender(
      <ShellHarness
        artifact={otherArtifact}
        initialOpen
        onCommentsOpenChange={onCommentsOpenChange}
      />
    );

    // packages/app/AGENTS.md: entity-detail drafts are scoped to the entity.
    expect(screen.getByRole("textbox", { name: "Add a comment" })).toHaveValue(
      ""
    );
    expect(screen.getByRole("tab", { name: "Artifact" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    onCommentsOpenChange.mockClear();
    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    await user.click(screen.getByRole("tab", { name: "Artifact" }));
    expect(onCommentsOpenChange).toHaveBeenLastCalledWith(true);
  });
});
