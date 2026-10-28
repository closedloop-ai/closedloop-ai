import { EventGroupRow } from "@repo/app/agents/components/events/event-group-row";
import type {
  SessionEvent,
  SessionEventGroup,
} from "@repo/app/agents/lib/session-types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

const EVENT_COUNT_SUFFIX = "events";

function buildEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "event-1",
    sessionId: "session-1",
    eventType: "tool_call",
    status: "completed",
    title: "Ran a tool",
    createdAt: "2026-01-05T10:00:00.000Z",
    ...overrides,
  };
}

function buildGroup(
  overrides: Partial<SessionEventGroup> = {}
): SessionEventGroup {
  return {
    id: "group-1",
    title: "Group title",
    events: [buildEvent()],
    ...overrides,
  };
}

describe("EventGroupRow header", () => {
  it("renders the group title and the first event's tool name", () => {
    render(
      <EventGroupRow
        group={buildGroup({
          events: [buildEvent({ toolName: "Read" })],
        })}
      />
    );

    expect(screen.getByText("Group title")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("omits the tool name badge when the first event has none", () => {
    render(<EventGroupRow group={buildGroup()} />);

    expect(screen.queryByText("Read")).toBeNull();
  });

  it("shows a duration label only when the group provides one", () => {
    const { rerender } = render(
      <EventGroupRow group={buildGroup({ durationLabel: "12s" })} />
    );
    expect(screen.getByText("12s")).toBeInTheDocument();

    rerender(<EventGroupRow group={buildGroup()} />);
    expect(screen.queryByText("12s")).toBeNull();
  });

  it("shows the first event's agent label and project when present", () => {
    render(
      <EventGroupRow
        group={buildGroup({
          events: [
            buildEvent({ agentLabel: "Bug Hunter", project: "closedloop-ai" }),
          ],
        })}
      />
    );

    expect(screen.getByText("Bug Hunter")).toBeInTheDocument();
    expect(screen.getByText("closedloop-ai")).toBeInTheDocument();
  });

  it("does not render an event count for a single-event group", () => {
    render(<EventGroupRow group={buildGroup()} />);

    expect(
      screen.queryByText((text) => text.endsWith(EVENT_COUNT_SUFFIX))
    ).toBeNull();
  });

  it("renders the event count for a multi-event group", () => {
    render(
      <EventGroupRow
        group={buildGroup({
          events: [
            buildEvent({ id: "e1", status: "working" }),
            buildEvent({ id: "e2", status: "completed" }),
          ],
        })}
      />
    );

    expect(screen.getByText(`2 ${EVENT_COUNT_SUFFIX}`)).toBeInTheDocument();
  });

  it("collapses consecutive duplicate statuses into a single transition sequence", () => {
    render(
      <EventGroupRow
        group={buildGroup({
          events: [
            buildEvent({ id: "e1", status: "working" }),
            buildEvent({ id: "e2", status: "working" }),
            buildEvent({ id: "e3", status: "completed" }),
          ],
        })}
      />
    );

    // Two distinct statuses in the collapsed sequence means exactly one arrow.
    expect(screen.getAllByText("→")).toHaveLength(1);
  });
});

describe("EventGroupRow expansion", () => {
  it("starts collapsed by default and expands on click", async () => {
    const user = userEvent.setup();
    render(
      <EventGroupRow
        group={buildGroup({ events: [buildEvent({ title: "Ran a tool" })] })}
      />
    );

    const toggle = screen.getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Ran a tool")).toBeNull();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Ran a tool")).toBeInTheDocument();
  });

  it("starts expanded when defaultExpanded is true", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({ events: [buildEvent({ title: "Ran a tool" })] })}
      />
    );

    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Ran a tool")).toBeInTheDocument();
  });

  it("labels a multi-event expansion with the grouped-event count", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [buildEvent({ id: "e1" }), buildEvent({ id: "e2" })],
        })}
      />
    );

    expect(screen.getByText("2 grouped events")).toBeInTheDocument();
  });
});

describe("EventGroupRow event details", () => {
  it("renders an event's summary only when present", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [buildEvent({ summary: "Did the thing" })],
        })}
      />
    );

    expect(screen.getByText("Did the thing")).toBeInTheDocument();
  });

  it("renders metadata chips as label/value pairs", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [
            buildEvent({
              metadata: [{ label: "lines", value: "42" }],
            }),
          ],
        })}
      />
    );

    expect(screen.getByText("lines")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders nothing extra for an event with no detail", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({ events: [buildEvent()] })}
      />
    );

    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders the detail summary headline and bullets", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [
            buildEvent({
              detail: {
                summary: {
                  headline: "What happened",
                  bullets: ["Did A", "Did B"],
                },
                fields: [],
              },
            }),
          ],
        })}
      />
    );

    expect(screen.getByText("What happened")).toBeInTheDocument();
    expect(screen.getByText("Did A")).toBeInTheDocument();
    expect(screen.getByText("Did B")).toBeInTheDocument();
  });

  it("omits the bullet list when the summary has none", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [
            buildEvent({
              detail: {
                summary: { headline: "What happened" },
                fields: [],
              },
            }),
          ],
        })}
      />
    );

    expect(screen.getByText("What happened")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("formats a null field value as the literal string 'null'", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [
            buildEvent({
              detail: {
                fields: [{ key: "result", label: "Result", value: null }],
              },
            }),
          ],
        })}
      />
    );

    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("formats string, number, and boolean field values as plain text", () => {
    render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [
            buildEvent({
              detail: {
                fields: [
                  { key: "a", label: "A", value: "plain" },
                  { key: "b", label: "B", value: 42 },
                  { key: "c", label: "C", value: true },
                ],
              },
            }),
          ],
        })}
      />
    );

    expect(screen.getByText("plain")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  it("formats an object/array field value as pretty-printed JSON", () => {
    const { container } = render(
      <EventGroupRow
        defaultExpanded={true}
        group={buildGroup({
          events: [
            buildEvent({
              detail: {
                fields: [
                  { key: "payload", label: "Payload", value: { count: 3 } },
                ],
              },
            }),
          ],
        })}
      />
    );

    expect(screen.getByText("Payload")).toBeInTheDocument();
    // Pretty-printed (indented) JSON, not the compact single-line form.
    expect(container.textContent).toContain('"count": 3');
  });
});
