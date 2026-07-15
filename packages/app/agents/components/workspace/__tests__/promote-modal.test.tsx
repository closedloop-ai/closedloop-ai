import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import { PromoteModal } from "../promote-modal";

const SUCCESS_MESSAGE = /promoted successfully/i;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-component-1",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7,
    klocPerDollar: 3.14,
    trend: [1, 2, 3],
    owner: "alice",
    collaborators: ["bob"],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const promoteRoute: FixtureRoute = {
  method: "POST",
  path: "/agent-components/promote",
  respond: () => ({
    catalogItemId: "catalog-item-1",
    distributionId: "distribution-1",
  }),
};

/**
 * Parent-controlled harness mirroring the real mount (`open` state owned by the
 * caller, a stable `component` object). Exposes a Reopen button so a test can
 * dismiss and reopen the modal for the same component.
 */
function ControlledPromoteModal({ component }: { component: AgentComponent }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Reopen
      </button>
      <PromoteModal component={component} onOpenChange={setOpen} open={open} />
    </>
  );
}

describe("PromoteModal", () => {
  // Regression (FEA-3028): dismissing via ESC (Radix `onOpenChange`) must reset
  // the success/error state so reopening the modal for the same component shows
  // a fresh form instead of the stale success screen.
  it("resets the success screen when dismissed via ESC and reopened", async () => {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders apiRoutes={[promoteRoute]}>
        <ControlledPromoteModal component={makeComponent()} />
      </AppCoreStoryProviders>
    );

    await user.click(
      screen.getByRole("button", { name: "Promote & Distribute" })
    );

    // Success screen with the created ids.
    await screen.findByText(SUCCESS_MESSAGE);
    expect(screen.getByText("catalog-item-1")).toBeInTheDocument();

    // Dismiss via ESC — routes through the Radix Dialog `onOpenChange`, not the
    // Cancel/Done buttons.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText(SUCCESS_MESSAGE)).not.toBeInTheDocument()
    );

    // Reopen for the same component: form should be fresh, not the stale
    // success screen.
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await screen.findByLabelText("Name");
    expect(screen.queryByText(SUCCESS_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText("catalog-item-1")).not.toBeInTheDocument();
  });

  // Regression (FEA-3028 follow-up): because `handleClose` clears `name` on
  // dismissal and the parent keeps the same component object mounted, reopening
  // must re-prefill the Name field — otherwise the default promote flow hits
  // "Name is required." on an empty field.
  it("re-prefills the name when reopened for the same component after ESC", async () => {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders apiRoutes={[promoteRoute]}>
        <ControlledPromoteModal component={makeComponent()} />
      </AppCoreStoryProviders>
    );

    const nameInput = await screen.findByLabelText<HTMLInputElement>("Name");
    expect(nameInput.value).toBe("My Orchestrator Agent");

    // Dismiss via ESC without submitting, then reopen the same component.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Reopen" }));

    const reopenedNameInput =
      await screen.findByLabelText<HTMLInputElement>("Name");
    expect(reopenedNameInput.value).toBe("My Orchestrator Agent");
  });
});
