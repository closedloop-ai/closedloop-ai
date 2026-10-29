import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefreshCwIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { genericArtifacts } from "../../fixtures";
import {
  type ArtifactShellPresentation,
  GenericArtifactDetailShell,
} from "../generic-artifact-detail-shell";

const artifact = genericArtifacts[0]!;
const CANVAS = "Artifact viewer and editor canvas";
const CANVAS_PLACEHOLDER = "[Artifact Canvas]";
const PUBLISH = "Publish";
const SESSIONS_TRACE_HEADING = "Session Trace";
// ISS-10789 removed the Trace tab; the fourth tab is Activity, which the
// prototype labels as design pending until ISS-10844 ships.
const ACTIVITY_PENDING = "Activity design pending";

function renderShell(
  overrides: Partial<ComponentProps<typeof GenericArtifactDetailShell>> = {}
) {
  return render(
    <GenericArtifactDetailShell
      artifact={artifact}
      commentsOpen={false}
      onCommentsOpenChange={vi.fn()}
      {...overrides}
    />
  );
}

function canvasState() {
  // ISS-10791: the labelled region carries the lifecycle attribute itself in
  // both frames; before the shared ArtifactTab the framed variant put it on an
  // inner div.
  return screen
    .getByRole("region", { name: CANVAS })
    .getAttribute("data-artifact-canvas-state");
}

describe("GenericArtifactDetailShell canvas states", () => {
  it("renders the ready placeholder canvas by default", () => {
    renderShell();

    expect(screen.getByText(CANVAS_PLACEHOLDER)).toBeInTheDocument();
    expect(canvasState()).toBe("ready");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the presentation's placeholder text on the stand-in canvas", () => {
    renderShell({
      presentation: { canvas: { placeholder: "Fixture: doc canvas" } },
    });

    const region = screen.getByRole("region", { name: CANVAS });
    expect(within(region).getByText("Fixture: doc canvas")).toBeVisible();
    expect(screen.queryByText(CANVAS_PLACEHOLDER)).toBeNull();
  });

  it("keeps the same artifact's canvas through a refetch", () => {
    const shellProps = {
      artifact,
      commentsOpen: false,
      onCommentsOpenChange: vi.fn(),
      panels: { artifact: <p>Fixture: real canvas</p> },
    };
    const { rerender } = render(<GenericArtifactDetailShell {...shellProps} />);
    expect(screen.getByText("Fixture: real canvas")).toBeVisible();

    rerender(
      <GenericArtifactDetailShell
        presentation={{ canvas: { state: "loading" } }}
        {...shellProps}
      />
    );
    expect(screen.getByText("Fixture: real canvas")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: CANVAS })).toHaveAttribute(
      "aria-busy",
      "true"
    );
  });

  it("starts a different artifact's canvas from first paint", () => {
    const other = genericArtifacts[1]!;
    const shellProps = {
      commentsOpen: false,
      onCommentsOpenChange: vi.fn(),
      panels: { artifact: <p>Fixture: real canvas</p> },
    };
    const { rerender } = render(
      <GenericArtifactDetailShell artifact={artifact} {...shellProps} />
    );
    expect(screen.getByText("Fixture: real canvas")).toBeVisible();

    rerender(
      <GenericArtifactDetailShell
        artifact={other}
        presentation={{ canvas: { state: "loading" } }}
        {...shellProps}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading artifact");
    expect(screen.queryByText("Fixture: real canvas")).not.toBeInTheDocument();
  });

  it("announces the default loading state politely", () => {
    renderShell({
      presentation: { canvas: { placeholder: "Doc canvas", state: "loading" } },
    });

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(within(status).getByText("Loading artifact")).toBeInTheDocument();
    expect(
      within(status).getByText(
        "Preparing the artifact viewer and its latest content."
      )
    ).toBeInTheDocument();
    expect(canvasState()).toBe("loading");
  });

  it("merges partial overrides over the default empty state and runs its primary action", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderShell({
      presentation: {
        canvas: {
          empty: {
            action: { icon: RefreshCwIcon, label: "Start writing", onSelect },
            title: "Blank page",
          },
          state: "empty",
        },
      },
    });

    expect(
      screen.getByRole("heading", { name: "Blank page" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This artifact does not have any content to display yet."
      )
    ).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Start writing" });
    expect(action.querySelector("svg")).not.toBeNull();
    expect(action).toHaveClass("bg-primary");
    await user.click(action);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(canvasState()).toBe("empty");
  });

  it("renders a secondary empty action as an outline button without an icon", () => {
    renderShell({
      presentation: {
        canvas: {
          empty: {
            action: {
              label: "Import",
              onSelect: vi.fn(),
              variant: "secondary",
            },
          },
          state: "empty",
        },
      },
    });

    const action = screen.getByRole("button", { name: "Import" });
    expect(action).toHaveClass("bg-input");
    expect(action.querySelector("svg")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Nothing to show yet" })
    ).toBeInTheDocument();
  });

  it("renders an empty state without an action", () => {
    renderShell({ presentation: { canvas: { state: "empty" } } });

    expect(
      screen.getByRole("heading", { name: "Nothing to show yet" })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: CANVAS })).queryByRole("button")
    ).toBeNull();
  });

  it("shows the error alert with its retry action", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderShell({
      presentation: {
        canvas: {
          error: {
            action: { icon: RefreshCwIcon, label: "Retry", onSelect },
            description: "Upstream timed out.",
          },
          state: "error",
        },
      },
    });

    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByText("Unable to load artifact")
    ).toBeInTheDocument();
    expect(within(alert).getByText("Upstream timed out.")).toBeInTheDocument();
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(retry.querySelector("svg")).not.toBeNull();
    await user.click(retry);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(canvasState()).toBe("error");
  });

  it("shows the default error copy without an action", () => {
    renderShell({ presentation: { canvas: { state: "error" } } });

    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByText(
        "The artifact could not be loaded. Try again in a moment."
      )
    ).toBeInTheDocument();
    expect(within(alert).queryByRole("button")).toBeNull();
  });

  it("renders an error action without an icon", () => {
    renderShell({
      presentation: {
        canvas: {
          error: { action: { label: "Retry", onSelect: vi.fn() } },
          state: "error",
        },
      },
    });

    expect(
      within(screen.getByRole("alert"))
        .getByRole("button", { name: "Retry" })
        .querySelector("svg")
    ).toBeNull();
  });
});

describe("GenericArtifactDetailShell artifact panel", () => {
  it("frames a supplied artifact panel inside the padded canvas", () => {
    renderShell({ panels: { artifact: <p>Custom viewer</p> } });

    const panel = screen.getByRole("region", { name: CANVAS });
    expect(panel).toHaveAttribute("data-artifact-frame", "framed");
    expect(canvasState()).toBe("ready");
    expect(within(panel).getByText("Custom viewer")).toBeInTheDocument();
    expect(screen.queryByText(CANVAS_PLACEHOLDER)).toBeNull();
  });

  it("lets a flush artifact panel become the canvas boundary", () => {
    renderShell({
      panels: { artifact: <p>Prototype frame</p> },
      presentation: { canvas: { frame: "flush" } },
    });

    const panel = screen.getByRole("region", { name: CANVAS });
    expect(panel).toHaveAttribute("data-artifact-canvas-state", "ready");
    expect(panel.firstElementChild).toHaveTextContent("Prototype frame");
  });
});

describe("GenericArtifactDetailShell header actions", () => {
  function buildActions() {
    const onPublish = vi.fn<() => void>();
    const onShare = vi.fn<() => void>();
    const actions: ArtifactShellPresentation["actions"] = [
      {
        icon: RefreshCwIcon,
        label: PUBLISH,
        onSelect: onPublish,
        variant: "primary",
      },
      { label: "Share", onSelect: onShare },
    ];
    return { actions, onPublish, onShare };
  }

  it("shows actions on the artifact tab with their variants and runs them", async () => {
    const user = userEvent.setup();
    const { actions, onPublish, onShare } = buildActions();
    renderShell({ presentation: { actions } });

    const publish = screen.getByRole("button", { name: PUBLISH });
    const share = screen.getByRole("button", { name: "Share" });
    expect(publish).toHaveClass("bg-primary");
    expect(publish.querySelector("svg")).not.toBeNull();
    expect(share).toHaveClass("bg-input");
    expect(share.querySelector("svg")).toBeNull();
    await user.click(share);
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("hides actions off the artifact tab", () => {
    renderShell({
      initialTab: "details",
      panels: { details: <p>Details panel</p> },
      presentation: { actions: buildActions().actions },
    });

    expect(screen.getByText("Details panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: PUBLISH })).toBeNull();
  });

  it("lists collaborators beside the tabs", () => {
    renderShell();

    // ISS-12273: one statement on the wrapper, so each name is asserted inside
    // that single label.
    for (const name of artifact.collaborators) {
      expect(
        screen.getAllByRole("img", { name: new RegExp(name) }).length
      ).toBeGreaterThan(0);
    }
  });
});

describe("GenericArtifactDetailShell default panels", () => {
  it("renders the common details panel on the details tab", () => {
    renderShell({ initialTab: "details" });

    expect(
      screen.getByRole("heading", { name: "Version history" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { hidden: true })).toBeNull();
  });

  it("renders the sessions trace on the sessions tab", () => {
    renderShell({ initialTab: "sessions" });

    expect(screen.getByText(SESSIONS_TRACE_HEADING)).toBeInTheDocument();
  });

  it("anchors only trace-row session comments into the sessions trace", () => {
    const quote = "Added the variant and a focused unit test:";
    const { rerender } = renderShell({ initialTab: "sessions" });
    expect(
      Array.from(document.querySelectorAll("mark"), (mark) => mark.textContent)
    ).toEqual([quote]);

    rerender(
      <GenericArtifactDetailShell
        artifact={artifact}
        commentsOpen={false}
        initialComments={{
          sessions: [
            {
              anchorPreview: quote,
              author: "Sam Chen",
              body: "No row",
              context: "",
              id: "unrowed",
              time: "now",
            },
          ],
        }}
        initialTab="sessions"
        key="unrowed"
        onCommentsOpenChange={vi.fn()}
      />
    );
    expect(document.querySelectorAll("mark")).toHaveLength(0);
  });

  it("shows the design-pending Activity state on the activity tab", () => {
    renderShell({ initialTab: "activity" });

    expect(screen.getByText(ACTIVITY_PENDING)).toBeInTheDocument();
  });

  it("prefers supplied panels for every non-artifact tab", () => {
    const { rerender } = renderShell({
      initialTab: "activity",
      panels: { sessions: <p>My sessions</p>, activity: <p>My activity</p> },
    });
    expect(screen.getByText("My activity")).toBeInTheDocument();
    expect(screen.queryByText(ACTIVITY_PENDING)).toBeNull();

    rerender(
      <GenericArtifactDetailShell
        artifact={artifact}
        commentsOpen={false}
        initialTab="sessions"
        onCommentsOpenChange={vi.fn()}
        panels={{ sessions: <p>My sessions</p>, activity: <p>My activity</p> }}
      />
    );
    expect(screen.getByText("My sessions")).toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_TRACE_HEADING)).toBeNull();
  });
});
