import { stubResizableContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericArtifactDetailShell } from "../generic-artifact-detail-shell";
import {
  ACTIVITY_PANEL,
  lightPanels,
  ShellHarness,
  shellArtifact,
} from "./support/detail-shell-harness";
import { FIND_TIMEOUT, FLOW_TIMEOUT_MS } from "./support/flow-timeouts";

const CANVAS_PLACEHOLDER = "[Artifact Canvas]";
const SEEDED_ARTIFACT_BODY =
  "This is a general artifact comment. Artifact-specific viewers can add anchored review behavior.";
const SEEDED_SHELL_BODY =
  "The comments rail remains consistent while the center viewer or editor changes by artifact type.";
const SEEDED_SESSION_BODY =
  "The revision session accounts for most of the rework cost in this trace.";

let widthStub: ReturnType<typeof stubResizableContainerWidthPx>;

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

function threadByBody(body: string) {
  const group = screen.getByText(body).closest('[role="group"]');
  if (!(group instanceof HTMLElement)) {
    throw new Error(`no thread for ${body}`);
  }
  return group;
}

async function chooseRailFilter(
  user: ReturnType<typeof userEvent.setup>,
  option: string
) {
  await user.click(screen.getByRole("button", { name: "All" }));
  await user.click(
    await screen.findByRole("menuitem", { name: option }, FIND_TIMEOUT)
  );
}

describe("GenericArtifactDetailShell initial tab changes", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("ignores a later initial tab that is not listed", () => {
    const { rerender } = render(
      <ShellHarness initialTab="artifact" tabs={["artifact", "details"]} />
    );

    rerender(
      <ShellHarness initialTab="activity" tabs={["artifact", "details"]} />
    );
    expect(screen.getByText(CANVAS_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.queryByText(ACTIVITY_PANEL)).toBeNull();

    rerender(
      <ShellHarness
        initialTab="activity"
        tabs={["artifact", "details", "activity"]}
      />
    );
    expect(screen.getByText(ACTIVITY_PANEL)).toBeInTheDocument();
  });
});

describe("GenericArtifactDetailShell seeded comments", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("seeds two open artifact-wide threads", async () => {
    const user = userEvent.setup();
    render(<ShellHarness initialOpen />);

    const first = threadByBody(SEEDED_ARTIFACT_BODY);
    const second = threadByBody(SEEDED_SHELL_BODY);
    expect(within(first).getByText("Ottilie Eastwick")).toBeInTheDocument();
    expect(within(first).getByText("8 min ago")).toBeInTheDocument();
    expect(within(second).getByText("Pascoe Birchall")).toBeInTheDocument();
    expect(within(second).getByText("3 min ago")).toBeInTheDocument();
    await chooseRailFilter(user, "Artifact comments");

    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  it.each([
    ["comment-1", SEEDED_ARTIFACT_BODY],
    ["comment-2", SEEDED_SHELL_BODY],
  ])("selects the seeded thread %s by id", (commentId, body) => {
    render(
      <ShellHarness
        artifactCommentSelectionRequest={{ commentId, nonce: 1 }}
        initialOpen
      />
    );

    expect(threadByBody(body)).toHaveAttribute("aria-current", "true");
    expect(
      screen
        .getAllByRole("group")
        .filter((group) => group.getAttribute("aria-current") === "true")
    ).toHaveLength(1);
  });

  it("seeds one trace-anchored session thread", async () => {
    const user = userEvent.setup();
    render(<ShellHarness initialTab="sessions" />);
    await user.click(screen.getByRole("button", { name: "Open rail" }));

    const thread = threadByBody(SEEDED_SESSION_BODY);
    expect(within(thread).getByText("Jordan Lee")).toBeInTheDocument();
    expect(within(thread).getByText("2 min ago")).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(1);
  });

  it("shows supplied session comments on the sessions tab", async () => {
    const user = userEvent.setup();
    render(
      <ShellHarness
        initialComments={{
          sessions: [
            {
              author: "Sam Chen",
              body: "Supplied session note",
              context: "",
              id: "s1",
              time: "now",
            },
          ],
        }}
        initialTab="sessions"
      />
    );
    await user.click(screen.getByRole("button", { name: "Open rail" }));

    expect(screen.getByText("Supplied session note")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Session comments 1" })
    ).toBeInTheDocument();
  });

  it("activates a session thread without a selection callback", async () => {
    const user = userEvent.setup();
    render(<ShellHarness initialTab="sessions" />);
    await user.click(screen.getByRole("button", { name: "Open rail" }));

    fireEvent.keyDown(threadByBody(SEEDED_SESSION_BODY), { key: "Enter" });

    expect(threadByBody(SEEDED_SESSION_BODY)).toHaveAttribute(
      "aria-current",
      "true"
    );
  });
});

describe("GenericArtifactDetailShell rail lifecycle", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("collapses a rail opened after mount when the shell narrows", async () => {
    const user = userEvent.setup();
    const onCommentsOpenChange = vi.fn();
    render(<ShellHarness onCommentsOpenChange={onCommentsOpenChange} />);
    await user.click(screen.getByRole("button", { name: "Open rail" }));

    act(() => widthStub.setWidth(900));

    expect(onCommentsOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not collapse a rail closed by the reader when the shell narrows", async () => {
    const user = userEvent.setup();
    const onCommentsOpenChange = vi.fn();
    render(
      <ShellHarness initialOpen onCommentsOpenChange={onCommentsOpenChange} />
    );
    await user.click(screen.getByRole("button", { name: "Close comments" }));
    onCommentsOpenChange.mockClear();

    act(() => widthStub.setWidth(900));

    expect(onCommentsOpenChange).not.toHaveBeenCalled();
  });
});

describe("GenericArtifactDetailShell canvas edges", () => {
  it("frames a supplied artifact panel when the presentation has no canvas config", () => {
    render(
      <GenericArtifactDetailShell
        artifact={shellArtifact}
        commentsOpen={false}
        onCommentsOpenChange={vi.fn()}
        panels={{ ...lightPanels, artifact: <p>Custom viewer</p> }}
        presentation={{ actions: [] }}
      />
    );

    expect(screen.getByText("Custom viewer")).toBeInTheDocument();
  });

  it.each([
    ["loading", "Loading artifact"],
    ["error", "Unable to load artifact"],
  ] as const)("renders the %s state title once", (state, title) => {
    render(
      <GenericArtifactDetailShell
        artifact={shellArtifact}
        commentsOpen={false}
        onCommentsOpenChange={vi.fn()}
        presentation={{ canvas: { state } }}
      />
    );

    expect(screen.getAllByText(title)).toHaveLength(1);
  });
});
