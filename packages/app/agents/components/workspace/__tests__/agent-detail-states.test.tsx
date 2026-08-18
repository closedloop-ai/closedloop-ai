import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  AgentDetailLoading,
  AgentDetailNotFound,
  AgentDetailUnavailable,
} from "../agent-detail-states";

const BACK_TO_AGENTS_LINK_NAME = /back to agents/i;
const SKELETON_SELECTOR = "[data-slot='skeleton']";
const RE_NOT_FOUND = /component not found/i;
const RE_UNAVAILABLE = /component unavailable/i;
const RE_LOADING_STATUS = /loading component details/i;

function renderState(ui: React.ReactElement) {
  return render(<AppCoreStoryProviders>{ui}</AppCoreStoryProviders>);
}

// FEA-3987: the shared Agent/component detail loading / not-found / unavailable
// states now match their sibling detail views (an accessible <Skeleton> while
// loading, the shared EmptyState + "Back to Agents" link on 404/empty, and a
// distinct transient state) instead of the bare centered text they used before,
// and instead of collapsing every read failure into "not found".
describe("AgentDetail loading/not-found/unavailable states (FEA-3987)", () => {
  it("renders an accessible skeleton (not bare 'Loading…' text) while loading", () => {
    renderState(<AgentDetailLoading />);

    // The visual slab is a Skeleton, hidden from the a11y tree...
    const skeleton = document.querySelector(SKELETON_SELECTOR);
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute("aria-hidden");
    // ...while a busy status carries an accessible name for screen readers, so
    // pending is announced rather than silent (the pre-fix bare text is gone).
    expect(screen.getByRole("status")).toHaveAccessibleName(RE_LOADING_STATUS);
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("renders the not-found EmptyState with a title + a way back", () => {
    renderState(<AgentDetailNotFound backHref="/acme/agents" />);

    expect(screen.getByText(RE_NOT_FOUND)).toBeInTheDocument();
    // No skeleton once the read has settled to not-found.
    expect(document.querySelector(SKELETON_SELECTOR)).not.toBeInTheDocument();
    // A way back: the "Back to Agents" link points at the injected list route.
    expect(
      screen.getByRole("link", { name: BACK_TO_AGENTS_LINK_NAME })
    ).toHaveAttribute("href", "/acme/agents");
  });

  it("renders a distinct 'unavailable' state (not 'not found') on a transient error", () => {
    renderState(<AgentDetailUnavailable backHref="/acme/agents" />);

    // A transient failure must NOT claim the component doesn't exist.
    expect(screen.getByText(RE_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(RE_NOT_FOUND)).not.toBeInTheDocument();
    // Still a way back.
    expect(
      screen.getByRole("link", { name: BACK_TO_AGENTS_LINK_NAME })
    ).toHaveAttribute("href", "/acme/agents");
  });
});
