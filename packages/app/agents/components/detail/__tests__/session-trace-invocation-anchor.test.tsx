import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTrace, type SessionTraceItem } from "../session-trace";

const mockUseOrganizationUsers = vi.fn();

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (options?: { enabled?: boolean }) =>
    mockUseOrganizationUsers(options),
}));

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({ data: [] });
});

afterEach(() => {
  cleanup();
});

describe("SessionTrace invocation anchors", () => {
  it("opens and marks the exact provider tool row addressed by an invocation anchor", () => {
    const item = toolsItem(4, [
      {
        label: "Read",
        detail: "first",
        err: false,
        transcriptIdentity: {
          eventId: "event-1",
          providerToolUseId: "toolu_1",
        },
      },
      {
        label: "Bash",
        detail: "target",
        err: false,
        transcriptIdentity: {
          eventId: "event-2",
          providerToolUseId: "toolu_2",
        },
      },
    ]);
    const { container } = render(
      <SessionTrace
        invocationAnchor={{
          kind: AgentComponentInvocationAnchorKind.Event,
          eventId: "different-cloud-event-id",
          providerToolUseId: "toolu_2",
        }}
        items={[item]}
      />
    );

    const target = container.querySelector(
      '[data-invocation-anchor-target="true"]'
    );
    expect(target).not.toBeNull();
    expect(target).toHaveTextContent("Bash");
    expect(target).not.toHaveTextContent("Read");
  });
});

function toolsItem(
  row: number,
  toolRows: Extract<SessionTraceItem, { type: "tools" }>["items"]
): SessionTraceItem {
  return {
    type: "tools",
    _row: row,
    t: "00:00",
    tMs: row,
    endMs: row,
    cum: 0,
    actor: {
      name: "claude-opus-4-8",
      sessionId: "s1",
      human: null,
      color: "var(--primary)",
    },
    summary: `Ran ${toolRows.length} tools`,
    items: toolRows,
    hasFail: false,
    failN: 0,
    cats: {},
  };
}
