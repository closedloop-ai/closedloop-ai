import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-12269: the Properties card came off the NEW Session surface only.
 *
 * `AgentSessionShellView` states those values on its Details tab and so turns
 * the card off; the legacy page has no Details tab and keeps it until
 * `artifact-detail-shell` is the default. Removing it from both would leave a
 * flag-off reader no session properties at all.
 *
 * Both halves live here, on one fixture and one locator. The absence case alone
 * would pass if the card stopped rendering for everyone, which is exactly the
 * regression worth catching; the presence case is what makes it fail.
 *
 * A separate file rather than two more cases in `agent-session-detail-view.test.tsx`:
 * that file is a grandfathered over-ceiling module and the growth gate is
 * shrink-only, so focused coverage goes beside it, as its own comment directs.
 */
const PROPERTIES_TOGGLE_NAME = "Properties";

describe("who hosts the Session Properties card (ISS-12269)", () => {
  it("keeps the card on the legacy surface, which has no Details tab", async () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture()}
        />
      )
    );

    expect(
      await screen.findByRole("button", { name: PROPERTIES_TOGGLE_NAME })
    ).toBeInTheDocument();
  });

  it("drops the card when its host already states those values", async () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          rendersPropertiesCard={false}
          session={createAgentSessionDetailFixture()}
        />
      )
    );

    // Wait on the surface itself, not on the card's absence: a query that ran
    // before the view mounted would report "absent" either way.
    await screen.findByRole("heading", { level: 1 });
    expect(
      screen.queryByRole("button", { name: PROPERTIES_TOGGLE_NAME })
    ).toBeNull();
    expect(document.querySelector(".sd3-props")).toBeNull();
  });
});
