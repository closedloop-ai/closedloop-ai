import { DEFAULT_HUMAN_ACTOR_COLOR_TOKEN } from "@repo/api/src/agent-session-user-color";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { CHART_COLOR_TOKENS } from "@repo/design-system/components/ui/chart-colors";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BranchEventDotRail } from "../branch-event-dot-rail";

/**
 * ISS-8656 is authoritative: event dots are NOT actors. They report what
 * happened, so they keep their event-semantic status colours and must never
 * pick up the actor palette ISS-8772 consolidated. Two halves, both required —
 * the negative half alone passes against a selector that matches nothing.
 */
const DELIVERY_TOKEN = "var(--success-foreground)";
const STEERING_TOKEN = "var(--primary)";
const FAILURE_TOKEN = "var(--destructive)";

/** Every seat the actor authority can hand out, plus its unknown-actor neutral. */
const ACTOR_TOKEN_FRAGMENTS = [
  ...CHART_COLOR_TOKENS,
  DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
].map((token) => token.slice("var(".length, -1));

function ev(dot: "g" | "b" | "r", text: string, t: string): MergedTraceItem {
  return { type: "event", sessionId: "s1", t, dot, text };
}

const TRACE_ITEMS: MergedTraceItem[] = [
  ev("g", "Commit pushed", "2026-06-10T10:00:00.000Z"),
  ev("r", "CI failed", "2026-06-10T11:00:00.000Z"),
  ev("b", "autonomy step", "2026-06-10T11:30:00.000Z"),
];

describe("event dots are excluded from actor-colour consistency", () => {
  it("paints each dot its own event-semantic status colour", () => {
    const { container } = render(
      <BranchEventDotRail traceItems={TRACE_ITEMS} />
    );
    const backgrounds = dotBackgrounds(container);

    expect(backgrounds).toHaveLength(3);
    expect(backgrounds).toContain(DELIVERY_TOKEN);
    expect(backgrounds).toContain(STEERING_TOKEN);
    expect(backgrounds).toContain(FAILURE_TOKEN);
  });

  it("never lets an actor palette token reach a dot", () => {
    const { container } = render(
      <BranchEventDotRail traceItems={TRACE_ITEMS} />
    );

    for (const background of dotBackgrounds(container)) {
      for (const fragment of ACTOR_TOKEN_FRAGMENTS) {
        expect(background).not.toContain(fragment);
      }
    }
  });
});

function dotBackgrounds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".bq-dot"),
    (dot) => dot.style.background
  );
}
