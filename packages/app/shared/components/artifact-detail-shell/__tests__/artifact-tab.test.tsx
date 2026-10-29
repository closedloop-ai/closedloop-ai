import { ArtifactTab } from "@repo/app/shared/components/artifact-detail-shell/artifact-tab";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-10791. The Artifact tab owns framing, scrolling and the canvas states;
 * the canvas is opaque to it. Assertions go through roles and visible text,
 * which is what the adoption tickets (ISS-10796/10797) rely on.
 */

const CANVAS = <p>canvas content</p>;
const REGION = { name: "Artifact viewer and editor canvas" };
// Fixture wording: the tab ships none for permission; the host supplies it.
const PERMISSION_CONTENT = {
  description: "host permission description",
  title: "host permission title",
};

describe("ArtifactTab", () => {
  it("renders the passed canvas inside a labelled region when ready", () => {
    render(<ArtifactTab canvas={CANVAS} />);

    const region = screen.getByRole("region", REGION);
    expect(region).toHaveTextContent("canvas content");
  });

  it("renders any canvas without knowing what it is", () => {
    const { rerender } = render(<ArtifactTab canvas={<h2>A document</h2>} />);
    expect(screen.getByRole("heading", { name: "A document" })).toBeVisible();

    rerender(
      <ArtifactTab
        canvas={
          <ol aria-label="Timeline">
            <li>event</li>
          </ol>
        }
        frame="flush"
      />
    );
    expect(screen.getByRole("list", { name: "Timeline" })).toBeVisible();
  });

  it.each([
    ["loading", "Loading artifact"],
    ["empty", "Nothing to show yet"],
    ["error", "Unable to load artifact"],
    ["permission", PERMISSION_CONTENT.title],
  ] as const)("shows the %s state instead of the canvas", (state, title) => {
    render(
      <ArtifactTab
        canvas={CANVAS}
        state={state}
        stateContent={{ permission: PERMISSION_CONTENT }}
      />
    );

    expect(screen.getByText(title)).toBeVisible();
    expect(screen.queryByText("canvas content")).not.toBeInTheDocument();
    // The state renders inside the same region, so the canvas area never
    // disappears while it loads or fails.
    expect(screen.getByRole("region", REGION)).toHaveTextContent(title);
  });

  it("announces loading as a live status", () => {
    render(<ArtifactTab canvas={CANVAS} state="loading" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading artifact");
  });

  it("marks the error state as an alert and runs its action", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ArtifactTab
        canvas={CANVAS}
        state="error"
        stateContent={{
          error: { action: { label: "Retry", onSelect: onRetry } },
        }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to load artifact"
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps permission distinct from empty", () => {
    render(
      <ArtifactTab
        canvas={CANVAS}
        state="permission"
        stateContent={{ permission: PERMISSION_CONTENT }}
      />
    );

    expect(screen.queryByText("Nothing to show yet")).not.toBeInTheDocument();
    expect(screen.getByText(PERMISSION_CONTENT.description)).toBeVisible();
  });

  it("lets the adapter reword a state", () => {
    render(
      <ArtifactTab
        canvas={CANVAS}
        state="empty"
        stateContent={{
          empty: {
            description: "Run the session to see output.",
            title: "No output yet",
          },
        }}
      />
    );

    expect(screen.getByText("No output yet")).toBeVisible();
    expect(screen.getByText("Run the session to see output.")).toBeVisible();
    expect(screen.queryByText("Nothing to show yet")).not.toBeInTheDocument();
  });

  it("exposes the framed scroll container through scrollRef", () => {
    const scrollRef = createRef<HTMLDivElement>();
    render(<ArtifactTab canvas={CANVAS} scrollRef={scrollRef} />);

    expect(scrollRef.current).toBe(screen.getByRole("region", REGION));
  });

  it("lets the keyboard reach the framed scroll container", () => {
    render(<ArtifactTab canvas={CANVAS} />);

    expect(screen.getByRole("region", REGION)).toHaveAttribute("tabindex", "0");
  });

  it("leaves scrolling to the canvas in the flush frame", () => {
    render(<ArtifactTab canvas={CANVAS} frame="flush" />);

    const region = screen.getByRole("region", REGION);
    expect(region).toHaveTextContent("canvas content");
    // The flush frame owns no scroll container, so the tab adds no overflow of
    // its own for the canvas to fight with.
    expect(region.className).not.toContain("overflow-y-auto");
  });

  it("refuses the props each frame would ignore", () => {
    // ISS-10791 review (whitlockk, marisolashgrove): both of these used to typecheck
    // and silently do nothing. `tsc` is the assertion -- each @ts-expect-error
    // fails the build if its line starts compiling again.
    //
    // The ref is typed on purpose. An untyped `createRef()` is
    // `RefObject<unknown>`, which errors on the ref's own generic, and the
    // suppression below would absorb THAT instead of the frame-union
    // violation it names -- green even with the union deleted.
    const flushRef = createRef<HTMLElement>();
    render(
      <>
        {/* @ts-expect-error flush has no tab-owned scroll container to expose */}
        <ArtifactTab canvas={CANVAS} frame="flush" scrollRef={flushRef} />
        <ArtifactTab
          canvas={CANVAS}
          state="loading"
          stateContent={{
            // @ts-expect-error loading renders no button, so it takes no action
            loading: { action: { label: "Retry", onSelect: () => undefined } },
          }}
        />
      </>
    );

    expect(screen.getAllByRole("region", REGION)).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  describe("a later loading (background refetch)", () => {
    // A canvas with state of its own: what a refetch must not throw away.
    const DraftCanvas = <input aria-label="Draft" defaultValue="" />;

    it.each(["framed", "flush"] as const)(
      "keeps the same %s canvas mounted and marks the region busy",
      async (frame) => {
        const user = userEvent.setup();
        const { rerender } = render(
          <ArtifactTab canvas={DraftCanvas} frame={frame} />
        );
        await user.type(
          screen.getByRole("textbox", { name: "Draft" }),
          "typed"
        );
        const region = screen.getByRole("region", REGION);
        expect(region).not.toHaveAttribute("aria-busy");

        rerender(
          <ArtifactTab canvas={DraftCanvas} frame={frame} state="loading" />
        );
        expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
          "typed"
        );
        expect(region).toHaveAttribute("aria-busy", "true");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();

        rerender(
          <ArtifactTab canvas={DraftCanvas} frame={frame} state="ready" />
        );
        expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
          "typed"
        );
        expect(region).not.toHaveAttribute("aria-busy");
      }
    );

    it("still shows the skeleton when loading comes before the first ready", () => {
      const { rerender } = render(
        <ArtifactTab canvas={DraftCanvas} state="loading" />
      );
      expect(screen.getByRole("status")).toHaveTextContent("Loading artifact");
      expect(
        screen.queryByRole("textbox", { name: "Draft" })
      ).not.toBeInTheDocument();

      rerender(<ArtifactTab canvas={DraftCanvas} state="ready" />);
      expect(screen.getByRole("textbox", { name: "Draft" })).toBeVisible();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("lets an error replace the canvas, and a retry start from the skeleton", () => {
      const { rerender } = render(<ArtifactTab canvas={DraftCanvas} />);
      expect(screen.getByRole("textbox", { name: "Draft" })).toBeVisible();

      rerender(<ArtifactTab canvas={DraftCanvas} state="error" />);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to load artifact"
      );
      expect(
        screen.queryByRole("textbox", { name: "Draft" })
      ).not.toBeInTheDocument();

      // Retrying after the error: no canvas is mounted to keep, so the
      // skeleton is back rather than a fresh, busy canvas.
      rerender(<ArtifactTab canvas={DraftCanvas} state="loading" />);
      expect(screen.getByRole("status")).toHaveTextContent("Loading artifact");
      expect(
        screen.queryByRole("textbox", { name: "Draft" })
      ).not.toBeInTheDocument();
    });
  });

  it("renders no empty heading when the host passes no permission wording", () => {
    render(<ArtifactTab canvas={CANVAS} state="permission" />);

    const region = screen.getByRole("region", REGION);
    expect(region).toHaveAttribute("data-artifact-canvas-state", "permission");
    expect(region.querySelector("svg")).not.toBeNull();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(region.querySelector("p")).toBeNull();
  });

  it("uses the adapter's accessible name for the region", () => {
    render(<ArtifactTab canvas={CANVAS} label="Session transcript" />);

    expect(
      screen.getByRole("region", { name: "Session transcript" })
    ).toBeVisible();
  });
});
