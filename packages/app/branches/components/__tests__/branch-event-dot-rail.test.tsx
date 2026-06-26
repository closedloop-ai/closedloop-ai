import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchEventDotRail } from "../branch-event-dot-rail";

const CONNECT_RE = /connect github/i;
const COMMENTS_RE = /3 PR comments/;

function ev(dot: "g" | "b" | "r", text: string, t: string): MergedTraceItem {
  return { type: "event", sessionId: "s1", t, dot, text };
}

const traceItems: MergedTraceItem[] = [
  ev("g", "Commit pushed", "2026-06-10T10:00:00.000Z"),
  ev("r", "CI failed", "2026-06-10T11:00:00.000Z"),
  ev("b", "autonomy step", "2026-06-10T11:30:00.000Z"),
];

function dots(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".bq-dot"));
}

describe("BranchEventDotRail (E3)", () => {
  it("renders only green/red dots and a connect hint when GitHub is disconnected", () => {
    const { container } = render(
      <BranchEventDotRail githubConnected={false} traceItems={traceItems} />
    );
    // Blue (autonomy) dropped → exactly two outcome dots.
    expect(dots(container)).toHaveLength(2);
    expect(
      container.querySelectorAll(".bq-dot.d-green, .bq-dot.d-red")
    ).toHaveLength(2);
    expect(container.querySelector(".bq-dot.d-orange")).toBeNull();
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
  });

  it("shows neither the connect hint nor orange when the connection state is unknown", () => {
    // No `githubConnected` prop → unknown. We still render the outcome dots but
    // make no claim about GitHub connectivity (the v1 default, no producer yet).
    const { container } = render(
      <BranchEventDotRail traceItems={traceItems} />
    );
    expect(dots(container).length).toBeGreaterThan(0);
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(container.querySelector(".bq-dot.d-orange")).toBeNull();
  });

  it("shows an orange dot with the comment count when connected", () => {
    const { container } = render(
      <BranchEventDotRail
        githubConnected
        prCommentCount={3}
        traceItems={traceItems}
      />
    );
    expect(container.querySelector(".bq-dot.d-orange")).not.toBeNull();
    expect(screen.getByText(COMMENTS_RE)).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
  });

  it("scrubs to a dot's timestamp on click and highlights the active row", async () => {
    const onScrub = vi.fn();
    const { container } = render(
      <BranchEventDotRail
        activeRow={0}
        githubConnected
        onScrub={onScrub}
        traceItems={traceItems}
      />
    );
    const greenDot = container.querySelector<HTMLElement>(".bq-dot.d-green");
    expect(greenDot?.className).toContain("hot");
    await userEvent.click(greenDot as HTMLElement);
    // The green dot is the commit event at 10:00 — scrubbing by timestamp lets
    // the shared controller derive the nearest row AND scroll the trace.
    expect(onScrub).toHaveBeenCalledWith("2026-06-10T10:00:00.000Z");
  });

  it("never renders a blue/autonomy dot", () => {
    const { container } = render(
      <BranchEventDotRail githubConnected traceItems={traceItems} />
    );
    for (const dot of dots(container)) {
      expect(dot.className).not.toContain("d-b");
    }
  });

  it("renders a green merge lifecycle dot from mergedAt and scrubs to its time on click", async () => {
    const onScrub = vi.fn();
    const { container } = render(
      <BranchEventDotRail
        githubConnected
        mergedAt="2026-06-10T12:00:00.000Z"
        onScrub={onScrub}
        prNumber={42}
        traceItems={[]}
      />
    );
    // No trace events, just the lifecycle merge dot — clickable via its timestamp.
    const merge = container.querySelector<HTMLElement>(".bq-dot.d-green");
    expect(merge).not.toBeNull();
    expect(merge?.getAttribute("aria-label")).toBe("Merged #42");
    await userEvent.click(merge as HTMLElement);
    expect(onScrub).toHaveBeenCalledWith("2026-06-10T12:00:00.000Z");
  });
});
