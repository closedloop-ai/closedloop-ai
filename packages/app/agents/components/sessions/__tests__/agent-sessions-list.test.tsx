import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentSessionsListContent } from "../agent-sessions-list";

const NO_ITEMS: AgentSessionListItem[] = [];

function getSessionHref(item: AgentSessionListItem): string {
  return `/sessions/${item.id}`;
}

// review cid 3653690775: the desktop host wires `isSyncing` (local source not
// yet up vs a failed read) all the way down through its table body into the
// shared list content — an earlier WIP dropped it on that hop, so the syncing
// case fell back to the destructive errored alert + a no-op Retry. These prove
// the shared component honors the flag end to end when the list is empty.
describe("AgentSessionsListContent unavailable routing (FEA-4181)", () => {
  it("routes an errored empty (isSyncing omitted) to the errored alert with Retry", () => {
    render(
      <AgentSessionsListContent
        emptySignals={{ isUnavailable: true, hasActiveFilters: false }}
        getSessionHref={getSessionHref}
        isLoading={false}
        items={NO_ITEMS}
        onRetry={() => {
          /* wired but unused in this assertion */
        }}
      />
    );

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("routes a syncing empty (isSyncing) to the quiet holding message, no Retry", () => {
    render(
      <AgentSessionsListContent
        emptySignals={{ isUnavailable: true, hasActiveFilters: false }}
        getSessionHref={getSessionHref}
        isLoading={false}
        isSyncing
        items={NO_ITEMS}
        onRetry={() => {
          /* wired but must not be surfaced in the syncing state */
        }}
      />
    );

    expect(screen.getByText("Getting your sessions ready")).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load sessions")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });
});
