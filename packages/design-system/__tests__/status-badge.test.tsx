import {
  StatusDot,
  ToneBadge,
} from "@closedloop-ai/design-system/components/ui/primitives/status-badge";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Pins current behavior of `ToneBadge` / `StatusDot`: the Tone -> Badge
 * variant mapping, the pulse/pulseRing/showDot branches, and StatusDot's own
 * tone/pulse/className passthrough. Read-only characterization — never
 * change `status-badge.tsx` to make one of these pass.
 */

afterEach(cleanup);

describe("ToneBadge", () => {
  it("renders the label text", () => {
    render(<ToneBadge label="Active" />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("defaults to the neutral variant classes for the default tone", () => {
    render(<ToneBadge label="Default" />);
    const badge = screen.getByText("Default").closest("span");
    expect(badge?.className).toContain("border-input-border");
    expect(badge?.className).toContain("bg-input");
  });

  it.each([
    ["success", "border-success/25"],
    ["warning", "border-warning/30"],
    ["danger", "border-destructive/25"],
    ["info", "border-info/25"],
    ["accent", "border-primary/20"],
    ["muted", "border-border"],
  ] as const)(
    "maps tone=%s to its Badge variant classes",
    (tone, expectedClass) => {
      render(<ToneBadge label="Label" tone={tone} />);
      const badge = screen.getByText("Label").closest("span");
      expect(badge?.className).toContain(expectedClass);
    }
  );

  it("renders a StatusDot (aria-hidden span) when showDot is true (default)", () => {
    const { container } = render(<ToneBadge label="With dot" />);
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("rounded-full");
  });

  it("renders no dot when showDot is false", () => {
    const { container } = render(<ToneBadge label="No dot" showDot={false} />);
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot).toBeNull();
  });

  it("does not add the pulse class to the dot when pulse is false (default)", () => {
    const { container } = render(<ToneBadge label="No pulse" />);
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).not.toContain("animate-status-pulse");
  });

  it("adds the pulse class to the dot when pulse is true", () => {
    const { container } = render(<ToneBadge label="Pulse" pulse={true} />);
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).toContain("animate-status-pulse");
  });

  it("does not add ring classes when pulseRing is false (default)", () => {
    render(<ToneBadge label="No ring" />);
    const badge = screen.getByText("No ring").closest("span");
    expect(badge?.className).not.toContain("animate-status-pulse-ring");
  });

  it("adds ring classes when pulseRing is true", () => {
    render(<ToneBadge label="Ring" pulseRing={true} />);
    const badge = screen.getByText("Ring").closest("span");
    expect(badge?.className).toContain("motion-safe:animate-status-pulse-ring");
    expect(badge?.className).toContain("motion-reduce:ring-2");
    expect(badge?.className).toContain("focus-visible:outline-2");
  });

  it("passes through a caller className", () => {
    render(<ToneBadge className="my-custom-class" label="Classy" />);
    const badge = screen.getByText("Classy").closest("span");
    expect(badge?.className).toContain("my-custom-class");
  });

  it("passes through arbitrary props like data-testid and aria-label", () => {
    render(
      <ToneBadge
        aria-label="status pill"
        data-testid="tone-badge"
        label="Passthrough"
      />
    );
    const badge = screen.getByTestId("tone-badge");
    expect(badge).toHaveAttribute("aria-label", "status pill");
  });
});

describe("StatusDot", () => {
  it("defaults to bg-current when no tone is given", () => {
    const { container } = render(<StatusDot />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain("bg-current");
  });

  it("renders the tone's class when a tone is given", () => {
    const { container } = render(<StatusDot tone="success" />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain("bg-success");
    expect(dot?.className).not.toContain("bg-current");
  });

  it.each([
    ["default", "bg-foreground"],
    ["warning", "bg-warning"],
    ["danger", "bg-destructive"],
    ["info", "bg-info"],
    ["accent", "bg-primary"],
    ["muted", "bg-muted-foreground"],
  ] as const)("maps tone=%s to %s", (tone, expectedClass) => {
    const { container } = render(<StatusDot tone={tone} />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain(expectedClass);
  });

  it("adds the animation class when pulse is true", () => {
    const { container } = render(<StatusDot pulse={true} />);
    const dot = container.querySelector("span");
    expect(dot?.className).toContain("animate-status-pulse");
    expect(dot?.className).toContain("motion-reduce:animate-none");
  });

  it("has no animation class when pulse is false (default)", () => {
    const { container } = render(<StatusDot />);
    const dot = container.querySelector("span");
    expect(dot?.className).not.toContain("animate-status-pulse");
  });

  it("passes through className and other span props", () => {
    render(<StatusDot className="extra-class" data-testid="solo-dot" />);
    const dot = screen.getByTestId("solo-dot");
    expect(dot.className).toContain("extra-class");
    expect(dot.className).toContain("rounded-full");
  });
});

// ISS-12548: a marked pill remembers whether its focus came from a pointer, so
// Chromium's later keystroke-driven `:focus-visible` does not draw the
// detached outline around a pill that was only clicked.
describe("ToneBadge pulseRing focus origin (ISS-12548)", () => {
  function focusAs(element: HTMLElement, focusVisible: boolean) {
    const matches = HTMLElement.prototype.matches;
    const spy = vi
      .spyOn(HTMLElement.prototype, "matches")
      .mockImplementation(function (this: HTMLElement, selector: string) {
        return selector === ":focus-visible"
          ? focusVisible
          : matches.call(this, selector);
      });
    try {
      act(() => element.focus());
    } finally {
      spy.mockRestore();
    }
  }

  it("marks pointer focus, clears it on blur, and leaves keyboard focus unmarked", () => {
    render(<ToneBadge label="Ring" pulseRing tabIndex={0} />);
    const badge = screen.getByText("Ring").closest("span") as HTMLElement;
    expect(badge.className).toContain("data-pointer-focus:outline-none");

    focusAs(badge, false);
    expect(badge).toHaveAttribute("data-pointer-focus");
    act(() => badge.blur());
    expect(badge).not.toHaveAttribute("data-pointer-focus");

    focusAs(badge, true);
    expect(badge).not.toHaveAttribute("data-pointer-focus");
  });

  it("still calls the caller's focus and blur handlers", () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(
      <ToneBadge
        label="Ring"
        onBlur={onBlur}
        onFocus={onFocus}
        pulseRing
        tabIndex={0}
      />
    );
    const badge = screen.getByText("Ring").closest("span") as HTMLElement;
    focusAs(badge, false);
    act(() => badge.blur());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("never marks a pill without the ring", () => {
    render(<ToneBadge label="Plain" tabIndex={0} />);
    const badge = screen.getByText("Plain").closest("span") as HTMLElement;
    focusAs(badge, false);
    expect(badge).not.toHaveAttribute("data-pointer-focus");
  });
});
