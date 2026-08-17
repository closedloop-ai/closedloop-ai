/**
 * Unit tests for SessionTrace sub-agent rendering (FEA-3416 / FEA-4172): each
 * sub-agent invocation collapses into ONE summary box — name (+ type),
 * duration/tokens/cost meta, an event count, and an expandable disclosure that
 * reveals the underlying transcript. No per-sub-agent pills, no full timeline
 * by default. Split out of session-trace.test.tsx to keep both files under the
 * line ceiling.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTrace, type SessionTraceItem } from "../session-trace";

// The inline trace composer pulls org members for its @-mention picker; stub it
// so the sub-agent trace under test mounts without a live users query.
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

afterEach(() => {
  cleanup();
});

const SUBAGENT_BUTTON_NAME_RE = /planner/;
// The sr-only kind prefix ("Sub-agent") plus the invocation name — asserts the
// disclosure announces the row's kind, not just its name (FEA-4172 a11y fix).
// The accessible-name algorithm concatenates the sr-only prefix and the name
// without preserving the inter-span whitespace, so match across the boundary.
const SUBAGENT_A11Y_NAME_RE = /sub-agent.*planner/i;

const agentActor = {
  name: "claude-opus-4-8",
  sessionId: "s1",
  human: null,
  color: "var(--primary)",
};

function eventItem(row: number, t: string): SessionTraceItem {
  return {
    type: "event",
    _row: row,
    t,
    tMs: Date.parse(t),
    dot: "b",
    text: "Stop",
  };
}

function subagentItem(
  row: number,
  sub: string,
  body: Extract<SessionTraceItem, { type: "subagent" }>["body"],
  overrides?: Partial<Extract<SessionTraceItem, { type: "subagent" }>>
): SessionTraceItem {
  return {
    type: "subagent",
    _row: row,
    t: "00:00",
    tMs: row,
    cum: 0,
    actor: agentActor,
    sub,
    subagentType: null,
    status: "completed",
    model: "claude-opus-4-8",
    duration: null,
    tokens: null,
    cost: null,
    body,
    ...overrides,
  };
}

describe("SessionTrace sub-agent collapse", () => {
  it("collapses a sub-agent into one labeled block with an accurate event count", () => {
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(1, "code-reviewer", [
            // task + status are synthetic framing rows the projection adds; only
            // the tool/event lines are real activity turns that the count reports.
            // Real event lines carry a timestamp (`t: event.createdAt`).
            { kind: "task", text: "Review the diff" },
            { kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" },
            { kind: "event", text: "message", t: "2026-06-23T20:13:35.000Z" },
            {
              kind: "status",
              text: "completed",
              t: "2026-06-23T20:13:36.000Z",
            },
          ]),
        ]}
      />
    );

    // One collapsed block, collapsed by default (aria-expanded=false).
    const head = container.querySelector("button.st-sub-head");
    expect(head).not.toBeNull();
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    // The count reflects only the two real activity turns, not the framing rows.
    expect(container.querySelector(".st-sub-count")?.textContent).toBe(
      "(2 events)"
    );
    // Collapsed: the sub-agent's turns are not inflating the transcript yet.
    expect(container.querySelector(".st-sub-body")).toBeNull();
  });

  it("expands the sub-agent block to its full trace on click", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(1, "planner", [
            { kind: "task", text: "Draft a plan" },
            { kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" },
            { kind: "event", text: "message", t: "2026-06-23T20:13:35.000Z" },
            {
              kind: "status",
              text: "completed",
              t: "2026-06-23T20:13:36.000Z",
            },
          ]),
        ]}
      />
    );

    expect(container.querySelector(".st-sub-count")?.textContent).toBe(
      "(2 events)"
    );

    await user.click(
      screen.getByRole("button", { name: SUBAGENT_BUTTON_NAME_RE })
    );

    const body = container.querySelector(".st-sub-body");
    expect(body).not.toBeNull();
    expect(
      container
        .querySelector("button.st-sub-head")
        ?.getAttribute("aria-expanded")
    ).toBe("true");
    expect(body?.textContent).toContain("Draft a plan");
    // The model stays out of the collapsed summary but is preserved behind the
    // disclosure so the datum is not lost (FEA-4172 code-review follow-up).
    expect(container.querySelector(".st-sub-sum")?.textContent).not.toContain(
      "claude-opus-4-8"
    );
    expect(container.querySelector(".st-sub-info")?.textContent).toBe(
      "claude-opus-4-8"
    );
  });

  it("excludes the synthetic currentTool line from the sub-agent event count", () => {
    // buildSubagentBody prepends a synthetic `kind: "tool"` line for the
    // agent's live currentTool (no `t`). When it mirrors the last real tool
    // event, counting it double-reports the run's activity (FEA-3416). Only
    // real event lines carry a `t`, so the count must ignore the synthetic one.
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(1, "reviewer", [
            // Synthetic currentTool line — no timestamp.
            { kind: "tool", text: "Read" },
            // The one real tool event it mirrors — carries a timestamp.
            { kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" },
            { kind: "status", text: "running" },
          ]),
        ]}
      />
    );

    // One real activity turn, not two.
    expect(container.querySelector(".st-sub-count")?.textContent).toBe(
      "(1 event)"
    );
  });

  it("singularizes the count for a single-event sub-agent run", () => {
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(1, "solo", [
            { kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" },
            {
              kind: "status",
              text: "completed",
              t: "2026-06-23T20:13:36.000Z",
            },
          ]),
        ]}
      />
    );

    // Strict match so a broken plural rule ("(1 events)") is caught.
    expect(container.querySelector(".st-sub-count")?.textContent).toBe(
      "(1 event)"
    );
  });

  it("omits the count and renders a static (non-expandable) head when a sub-agent carries no activity lines", () => {
    // The branch merged trace supplies sub-agent items with an empty body; the
    // block must not render a misleading "(0 events)" label there, and — wongk
    // review — must not offer a chevron/disclosure that only opens to "No
    // transcript captured." A body-less row is a static head with no button.
    const { container } = render(
      <SessionTrace items={[subagentItem(1, "empty", [])]} />
    );

    // Static head: no interactive button, no aria-expanded, no chevron.
    expect(container.querySelector("button.st-sub-head")).toBeNull();
    const staticHead = container.querySelector("div.st-sub-head-static");
    expect(staticHead).not.toBeNull();
    expect(staticHead?.getAttribute("aria-expanded")).toBeNull();
    expect(container.querySelector(".st-sub-chev")).toBeNull();
    // The summary is still shown; there is just nothing behind a chevron.
    expect(container.querySelector(".st-sub-sum")?.textContent).toBe("empty");
    expect(container.querySelector(".st-sub-count")).toBeNull();
    // No empty "No transcript captured." disclosure body is rendered.
    expect(container.querySelector(".st-sub-body")).toBeNull();
  });

  it("keeps the cost meta title on a body-less (static) branch-merged-trace row", () => {
    // A branch merged trace row is body-less AND carries an attributed cost;
    // the attribution title must ride the static head's cost part too.
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(1, "reviewer", [], {
            duration: null,
            tokens: null,
            cost: "$0.20",
          }),
        ]}
      />
    );

    expect(container.querySelector("div.st-sub-head-static")).not.toBeNull();
    const costPart = container.querySelector(".st-sub-meta-part.cost");
    expect(costPart?.textContent).toBe("$0.20");
    expect(costPart?.getAttribute("title")).toBe(
      "Cost attributed to this sub-agent"
    );
  });

  it("collapses a sub-agent into one summary box with name + duration/tokens/cost, no timeline by default (FEA-4172)", () => {
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(
            1,
            "code-reviewer",
            [
              { kind: "task", text: "Review the diff" },
              { kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" },
              { kind: "event", text: "message", t: "2026-06-23T20:13:35.000Z" },
            ],
            { duration: "12s", tokens: "1.2k tok", cost: "$0.03" }
          ),
        ]}
      />
    );

    // Exactly one collapsed summary box — no per-sub-agent pills, no timeline.
    const heads = container.querySelectorAll("button.st-sub-head");
    expect(heads).toHaveLength(1);
    expect(container.querySelector(".st-sub-body")).toBeNull();
    // The summary carries the real name and duration/tokens/cost meta.
    expect(container.querySelector(".st-sub-sum")?.textContent).toBe(
      "code-reviewer"
    );
    const meta = container.querySelector(".st-sub-meta")?.textContent ?? "";
    expect(meta).toContain("12s");
    expect(meta).toContain("1.2k tok");
    expect(meta).toContain("$0.03");
  });

  it("renders duration · cost and drops the empty tokens part on the collapsed box (FEA-4178)", () => {
    // FEA-4178 truthful shape: the projection populates `cost` from the
    // sub-agent's attributed spend but has no per-sub-agent token source, so
    // `tokens` stays null. The box must render `duration · cost` and drop the
    // empty tokens part rather than show a dangling separator.
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(
            1,
            "code-reviewer",
            [{ kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" }],
            { duration: "1m 30s", tokens: null, cost: "$0.20" }
          ),
        ]}
      />
    );

    const meta = container.querySelector(".st-sub-meta")?.textContent ?? "";
    expect(meta).toBe("1m 30s · $0.20");
    // wongk review: cost carries its own part class so it can take full
    // `--foreground` contrast (matching the session-level gutter cost) rather
    // than sitting flat-muted; the cost part — and only it — is the `.cost` span.
    const costPart = container.querySelector(".st-sub-meta-part.cost");
    expect(costPart?.textContent).toBe("$0.20");
    const durationPart = container.querySelector(
      ".st-sub-meta-part:not(.cost)"
    );
    expect(durationPart?.textContent).toBe("1m 30s");
  });

  it("titles the cost part to name it as attributed, not metered, so a bare dollar amount does not overpromise (FEA-4178 wongk review)", () => {
    // The sub-agent cost is attributed by timestamp overlap with the main-agent
    // turns, not metered per sub-agent, so the collapsed box names what the
    // figure is on hover — mirroring the gutter cost's `Cumulative: $X` title.
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(
            1,
            "code-reviewer",
            [{ kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" }],
            { duration: "1m 30s", tokens: null, cost: "$0.20" }
          ),
        ]}
      />
    );

    const costPart = container.querySelector(".st-sub-meta-part.cost");
    expect(costPart?.getAttribute("title")).toBe(
      "Cost attributed to this sub-agent"
    );
    // The non-cost meta parts do not carry the cost title.
    const durationPart = container.querySelector(
      ".st-sub-meta-part:not(.cost)"
    );
    expect(durationPart?.getAttribute("title")).toBeNull();
  });

  it("omits the meta row entirely when duration, tokens, and cost are all absent (FEA-4178)", () => {
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(
            1,
            "code-reviewer",
            [{ kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" }],
            { duration: null, tokens: null, cost: null }
          ),
        ]}
      />
    );

    expect(container.querySelector(".st-sub-meta")).toBeNull();
  });

  it("labels the summary with the sub-agent type when it differs from the name (FEA-4172)", () => {
    const { container } = render(
      <SessionTrace
        items={[
          subagentItem(
            1,
            "reviewer",
            [{ kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" }],
            { subagentType: "code-reviewer" }
          ),
        ]}
      />
    );

    expect(container.querySelector(".st-sub-sum")?.textContent).toBe(
      "reviewer (code-reviewer)"
    );
  });

  it("announces the sub-agent kind in the disclosure's accessible name (FEA-4172 a11y)", () => {
    // The BotIcon that visually marks the row as a sub-agent is aria-hidden, so
    // without the sr-only prefix a screen reader would hear only the invocation
    // name ("planner"). Assert the kind context is restored to the button name.
    render(
      <SessionTrace
        items={[
          subagentItem(1, "planner", [
            { kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" },
          ]),
        ]}
      />
    );

    // getByRole computes the accessible name, which now includes the sr-only
    // kind prefix — matching on it would fail if the prefix were dropped.
    expect(
      screen.getByRole("button", { name: SUBAGENT_A11Y_NAME_RE })
    ).toBeInTheDocument();
  });

  it("keeps the parent trace turns rendered alongside a collapsed sub-agent (FEA-4172)", () => {
    const { container } = render(
      <SessionTrace
        items={[
          eventItem(0, "2026-06-23T20:13:33.000Z"),
          subagentItem(1, "planner", [
            { kind: "tool", text: "Read", t: "2026-06-23T20:13:34.000Z" },
          ]),
        ]}
      />
    );

    // Parent-level system event still renders; sub-agent stays a single box.
    expect(container.querySelector(".st-sysline")).not.toBeNull();
    expect(container.querySelectorAll("button.st-sub-head")).toHaveLength(1);
    expect(container.querySelector(".st-sub-body")).toBeNull();
  });
});
