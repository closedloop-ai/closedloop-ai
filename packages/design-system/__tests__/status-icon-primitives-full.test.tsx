import type { StatusGlyph } from "@closedloop-ai/design-system/components/ui/status-icon-primitives";
import {
  FilledStatusCircle,
  StatusDash,
  StatusRing,
} from "@closedloop-ai/design-system/components/ui/status-icon-primitives";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins current rendering behavior of the generic status-icon primitives:
 * `StatusRing`'s track/arc/inner-pie/spinner branches, `FilledStatusCircle`'s
 * glyph dispatch, and `StatusDash`'s single mark. Read-only characterization
 * — never change `status-icon-primitives.tsx` to make one of these pass.
 */

const TRACK_RADIUS = "9";
const INNER_PIE_RADIUS = "3";

afterEach(cleanup);

function circlesOf(container: HTMLElement) {
  return Array.from(container.querySelectorAll("circle"));
}

function findByRadiusAndClass(
  container: HTMLElement,
  radius: string,
  classSubstring: string
) {
  return circlesOf(container).find(
    (c) =>
      c.getAttribute("r") === radius &&
      (c.getAttribute("class") ?? "").includes(classSubstring)
  );
}

describe("StatusRing", () => {
  it("renders with the given aria-label and role=img", () => {
    render(<StatusRing color="var(--x)" label="Half done" percentage={50} />);
    expect(screen.getByRole("img", { name: "Half done" })).toBeInTheDocument();
  });

  it("at percentage=0 has only the track circle — no progress arc, no inner pie", () => {
    const { container } = render(
      <StatusRing color="var(--x)" label="Empty" percentage={0} />
    );
    const circles = circlesOf(container);
    expect(circles).toHaveLength(1);
    expect(circles[0]).toHaveAttribute("r", TRACK_RADIUS);
    expect(circles[0].getAttribute("class")).toBeNull();
  });

  it("at percentage=50 draws a progress arc with strokeDasharray plus the inner pie", () => {
    const { container } = render(
      <StatusRing
        color="var(--progress-foreground)"
        label="Half"
        percentage={50}
      />
    );
    const arc = findByRadiusAndClass(container, TRACK_RADIUS, "transition-all");
    const innerPie = findByRadiusAndClass(
      container,
      INNER_PIE_RADIUS,
      "transition-all"
    );
    expect(arc).toBeDefined();
    expect(arc).toHaveAttribute("stroke-dasharray");
    expect(arc).toHaveAttribute("stroke", "var(--progress-foreground)");
    expect(innerPie).toBeDefined();
  });

  it("with thinking=true renders a spinner circle with animate-spin", () => {
    const { container } = render(
      <StatusRing
        color="var(--x)"
        label="Thinking"
        percentage={50}
        thinking={true}
      />
    );
    const spinner = circlesOf(container).find((c) =>
      (c.getAttribute("class") ?? "").includes("animate-spin")
    );
    expect(spinner).toBeDefined();
    expect(spinner?.getAttribute("class")).toContain("origin-center");
  });

  it("with thinking=true hides the progress arc even when percentage > 0", () => {
    const { container } = render(
      <StatusRing
        color="var(--x)"
        label="Thinking"
        percentage={50}
        thinking={true}
      />
    );
    const arc = findByRadiusAndClass(container, TRACK_RADIUS, "transition-all");
    expect(arc).toBeUndefined();
    // The inner pie is unaffected by `thinking` — it stays visible for arc states.
    const innerPie = findByRadiusAndClass(
      container,
      INNER_PIE_RADIUS,
      "transition-all"
    );
    expect(innerPie).toBeDefined();
  });

  it("with dashed=true sets strokeDasharray on the track", () => {
    const { container } = render(
      <StatusRing
        color="var(--x)"
        dashed={true}
        label="Dashed"
        percentage={0}
      />
    );
    const [track] = circlesOf(container);
    expect(track).toHaveAttribute("stroke-dasharray", "3 3");
  });

  it("respects a custom trackColor", () => {
    const { container } = render(
      <StatusRing
        color="var(--x)"
        label="Custom track"
        percentage={0}
        trackColor="var(--custom-track)"
      />
    );
    const [track] = circlesOf(container);
    expect(track).toHaveAttribute("stroke", "var(--custom-track)");
  });

  it("respects a custom ringStrokeWidth on the track and arc", () => {
    const { container } = render(
      <StatusRing
        color="var(--x)"
        label="Custom width"
        percentage={50}
        ringStrokeWidth={4}
      />
    );
    const [track] = circlesOf(container);
    const arc = findByRadiusAndClass(container, TRACK_RADIUS, "transition-all");
    expect(track).toHaveAttribute("stroke-width", "4");
    expect(arc).toHaveAttribute("stroke-width", "4");
  });

  it("renders at the given size", () => {
    render(
      <StatusRing color="var(--x)" label="Sized" percentage={0} size={20} />
    );
    const svg = screen.getByRole("img", { name: "Sized" });
    expect(svg).toHaveAttribute("width", "20");
    expect(svg).toHaveAttribute("height", "20");
  });
});

describe("FilledStatusCircle", () => {
  it("renders with the given aria-label and role=img", () => {
    render(
      <FilledStatusCircle fill="var(--success)" glyph="check" label="Done" />
    );
    expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument();
  });

  it.each<StatusGlyph>(["check", "x", "swap", "exclamation", "bolt"])(
    "renders the %s glyph without error",
    (glyph) => {
      const { container } = render(
        <FilledStatusCircle fill="var(--success)" glyph={glyph} label={glyph} />
      );
      const circles = circlesOf(container);
      expect(circles.length).toBeGreaterThanOrEqual(1);
      expect(circles[0]).toHaveAttribute("fill", "var(--success)");
      expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(
        1
      );
    }
  );

  it("renders at the given size", () => {
    render(
      <FilledStatusCircle
        fill="var(--x)"
        glyph="check"
        label="Sized"
        size={20}
      />
    );
    const svg = screen.getByRole("img", { name: "Sized" });
    expect(svg).toHaveAttribute("width", "20");
    expect(svg).toHaveAttribute("height", "20");
  });
});

describe("StatusDash", () => {
  it("renders with the given aria-label and role=img", () => {
    render(<StatusDash label="Not measured" />);
    expect(
      screen.getByRole("img", { name: "Not measured" })
    ).toBeInTheDocument();
  });

  it("renders a single centered line with the default muted color", () => {
    const { container } = render(<StatusDash label="Not measured" />);
    const line = container.querySelector("line");
    expect(line).not.toBeNull();
    expect(line).toHaveAttribute("stroke", "var(--muted-foreground)");
    expect(line).toHaveAttribute("x1", "5");
    expect(line).toHaveAttribute("x2", "15");
    expect(line).toHaveAttribute("y1", "10");
    expect(line).toHaveAttribute("y2", "10");
  });

  it("respects a custom color", () => {
    const { container } = render(
      <StatusDash color="var(--custom-dash)" label="Not measured" />
    );
    const line = container.querySelector("line");
    expect(line).toHaveAttribute("stroke", "var(--custom-dash)");
  });

  it("renders at the given size", () => {
    render(<StatusDash label="Sized" size={20} />);
    const svg = screen.getByRole("img", { name: "Sized" });
    expect(svg).toHaveAttribute("width", "20");
    expect(svg).toHaveAttribute("height", "20");
  });
});
