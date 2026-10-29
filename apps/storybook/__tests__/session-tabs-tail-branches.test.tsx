/**
 * Branch tests for the Session Detail Artifact tab demo
 * (`stories/composites-v2/v2-session-detail-tabs.tsx`): the story sweep mounts
 * it but never presses a timeline control, so neither answer of its jump
 * handler runs.
 */
import { formatTime } from "@repo/app/shared/lib/date-utils";
import { render, screen } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionArtifactTabDemo } from "../stories/composites-v2/v2-session-detail-tabs";

const HUMAN_STEERING = { name: "Jump to Human steering" } as const;
// The bucket label is viewer-local (`formatTime`), so build it from the
// fixture's UTC instant rather than one zone's reading of it.
const IDLE_BUCKET = {
  name: `Activity bucket ${formatTime(new Date("2026-06-10T12:05:00.000Z"))}`,
} as const;

function activeRows(): string[] {
  return Array.from(document.querySelectorAll("[data-active]")).map(
    (node) =>
      `${node.getAttribute("data-row")}=${node.getAttribute("data-active")}`
  );
}

const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo"
);

function stubScrollTo() {
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo,
    writable: true,
  });
  return scrollTo;
}

afterEach(() => {
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

describe("SessionArtifactTabDemo", () => {
  it("scrolls the trace to the jumped row for a dot and not for an idle bucket", async () => {
    const scrollTo = stubScrollTo();
    render(<SessionArtifactTabDemo />);

    await userEvent.click(screen.getByRole("button", IDLE_BUCKET));
    expect(scrollTo).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", HUMAN_STEERING));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("marks the trace row a timeline dot jumps to as active", async () => {
    render(<SessionArtifactTabDemo />);
    expect(activeRows()).toEqual([]);

    await userEvent.click(screen.getByRole("button", HUMAN_STEERING));
    expect(activeRows()).toEqual(["0=true"]);
  });

  it("clears the active trace row when an idle bucket with nothing to jump to is pressed", async () => {
    render(<SessionArtifactTabDemo />);
    await userEvent.click(screen.getByRole("button", HUMAN_STEERING));
    expect(activeRows()).toEqual(["0=true"]);

    const idle = screen.getByRole("button", IDLE_BUCKET);
    expect(idle).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(idle);
    expect(activeRows()).toEqual([]);
  });
});
