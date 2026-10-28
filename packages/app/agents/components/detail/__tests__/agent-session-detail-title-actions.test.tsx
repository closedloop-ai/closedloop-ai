import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-12539: the title row's `titleActions` slot is where session detail
 * places the data controls deletion entry point, on desktop and web alike,
 * since both draw this view. The fixture button stands in for the entry point.
 */
describe("ISS-12539: AgentSessionDetailView titleActions", () => {
  it("renders the actions in the session's title row", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture()}
          titleActions={<button type="button">fixture-title-action</button>}
        />
      )
    );
    const action = screen.getByRole("button", {
      name: "fixture-title-action",
    });
    const titleRow = screen
      .getByRole("heading", { level: 1 })
      .closest("header");
    expect(titleRow).not.toBeNull();
    expect(titleRow).toContainElement(action);
  });

  it("renders nothing extra when a host passes no actions", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture()}
        />
      )
    );
    const titleRow = screen
      .getByRole("heading", { level: 1 })
      .closest("header");
    expect(titleRow?.querySelector(".ml-auto")).toBeNull();
  });
});
