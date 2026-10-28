import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import type { PromoteResponse } from "@repo/api/src/types/distribution";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "../../../../shared/storybook/fixture-fetch";
import { PromoteModal } from "../promote-modal";

const NAME_FIELD_LABEL = "Name";
const SUCCESS_MESSAGE = /promoted successfully/i;
const DESCRIPTION_LABEL = /description/i;

// Fixture helpers

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-component-1",
    slug: "subagent::my-orchestrator-agent",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7,
    locPerDollar: 3.14,
    trend: [1, 2, 3],
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
  respond: () => PROMOTE_RESULT,
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

    await user.click(screen.getByRole("button", { name: SUBMIT_LABEL }));

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
    await screen.findByLabelText(NAME_FIELD_LABEL);
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

    const nameInput =
      await screen.findByLabelText<HTMLInputElement>(NAME_FIELD_LABEL);
    expect(nameInput.value).toBe("My Orchestrator Agent");

    // Dismiss via ESC without submitting, then reopen the same component.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByLabelText(NAME_FIELD_LABEL)).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Reopen" }));

    const reopenedNameInput =
      await screen.findByLabelText<HTMLInputElement>(NAME_FIELD_LABEL);
    expect(reopenedNameInput.value).toBe("My Orchestrator Agent");
  });
});

/**
 * The ISS-5976 case: the parent re-renders with a NEW component OBJECT carrying
 * the same component `id`. That is exactly what a focus-triggered refetch of the
 * agent-component query hands `AgentDetail`, which passes it straight down here.
 *
 * Driven with `rerender` rather than an in-tree button because the open Radix
 * dialog marks everything outside it inert, so a trigger rendered as a sibling is
 * unreachable — and `rerender` models "the parent re-rendered with new data"
 * more directly anyway.
 */
function PromoteModalHarness({ component }: { component: AgentComponent }) {
  return (
    <AppCoreStoryProviders apiRoutes={[promoteRoute]}>
      <PromoteModal
        component={component}
        onOpenChange={() => {
          // Open is pinned: this is about an identity change while the dialog
          // stays open, not a dismiss/reopen cycle (covered above).
        }}
        open={true}
      />
    </AppCoreStoryProviders>
  );
}

describe("PromoteModal draft survival across a refetch (ISS-5976)", () => {
  it("keeps the admin's edited name and description when the component object is replaced", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <PromoteModalHarness component={makeComponent()} />
    );

    const nameInput =
      await screen.findByLabelText<HTMLInputElement>(NAME_FIELD_LABEL);
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed by the admin");
    const descriptionInput =
      screen.getByLabelText<HTMLTextAreaElement>(DESCRIPTION_LABEL);
    await user.type(descriptionInput, "Half-written description");

    // A fresh object for the SAME component id. The prefill is keyed on that id,
    // so it must not re-run and wipe the in-progress edit.
    rerender(<PromoteModalHarness component={makeComponent()} />);

    expect(
      screen.getByLabelText<HTMLInputElement>(NAME_FIELD_LABEL).value
    ).toBe("Renamed by the admin");
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(DESCRIPTION_LABEL).value
    ).toBe("Half-written description");
  });

  it("still prefills from a genuinely different component", async () => {
    // The guard keys on identity; it must not suppress the prefill outright. A
    // new component id is a new subject and MUST re-prefill.
    const { rerender } = render(
      <PromoteModalHarness component={makeComponent()} />
    );
    await screen.findByLabelText(NAME_FIELD_LABEL);

    rerender(
      <PromoteModalHarness
        component={makeComponent({
          id: "uuid-component-2",
          name: "Second Agent",
        })}
      />
    );

    await waitFor(() =>
      expect(
        screen.getByLabelText<HTMLInputElement>(NAME_FIELD_LABEL).value
      ).toBe("Second Agent")
    );
  });
});

describe("PromoteModal submit request (ISS-6635)", () => {
  it("sends the component id, trimmed name, trimmed description, and kind", async () => {
    const user = userEvent.setup();
    const captured: unknown[] = [];
    const component = makeComponent();
    render(
      <SubmitHarness
        component={component}
        route={createCapturingPromoteRoute(captured)}
      />
    );

    const nameInput =
      await screen.findByLabelText<HTMLInputElement>(NAME_FIELD_LABEL);
    await user.clear(nameInput);
    await user.type(nameInput, "  Renamed  ");
    await user.type(
      screen.getByLabelText<HTMLTextAreaElement>(DESCRIPTION_LABEL),
      "  Orchestrates the release train.  "
    );

    await user.click(screen.getByRole("button", { name: SUBMIT_LABEL }));
    await screen.findByText(SUCCESS_MESSAGE);

    // `id` deliberately differs from both `slug` and `name` on the fixture, so
    // a slug-for-id swap here would distribute the wrong software org-wide.
    expect(captured).toEqual([
      {
        agentComponentId: component.id,
        name: "Renamed",
        description: "Orchestrates the release train.",
        targetKind: component.kind,
      },
    ]);
  });

  it("omits description entirely when the admin typed only whitespace", async () => {
    const user = userEvent.setup();
    const captured: unknown[] = [];
    render(
      <SubmitHarness
        component={makeComponent()}
        route={createCapturingPromoteRoute(captured)}
      />
    );

    await user.type(
      await screen.findByLabelText<HTMLTextAreaElement>(DESCRIPTION_LABEL),
      "   "
    );
    await user.click(screen.getByRole("button", { name: SUBMIT_LABEL }));
    await screen.findByText(SUCCESS_MESSAGE);

    // `description.trim() || undefined` — an empty string would overwrite the
    // catalog item's description with blank rather than leaving it unset.
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("description");
  });
});

describe("PromoteModal blank-name guard (ISS-6637)", () => {
  it.each([
    ["an empty name", ""],
    ["a whitespace-only name", "   "],
  ])("blocks the request on %s", async (_label, typed) => {
    const user = userEvent.setup();
    const captured: unknown[] = [];
    render(
      <SubmitHarness
        component={makeComponent()}
        route={createCapturingPromoteRoute(captured)}
      />
    );

    const nameInput =
      await screen.findByLabelText<HTMLInputElement>(NAME_FIELD_LABEL);
    await user.clear(nameInput);
    if (typed) {
      await user.type(nameInput, typed);
    }

    await user.click(screen.getByRole("button", { name: SUBMIT_LABEL }));

    await screen.findByText("Name is required.");
    // The same message renders when the server 400s, so the message alone does
    // not prove the client guard ran. No request may leave the browser.
    expect(captured).toHaveLength(0);
  });
});

describe("PromoteModal rejected promote (ISS-6636)", () => {
  it("surfaces the server message and keeps the admin's draft", async () => {
    const user = userEvent.setup();
    const serverMessage = "Catalog slug already in use by pack acme/legacy";
    const draftDescription = "Half-written description";
    const captured: unknown[] = [];
    render(
      <SubmitHarness
        component={makeComponent()}
        route={createCapturingPromoteRoute(captured, {
          // A real 409 envelope, not a thrown transport error: the message has
          // to survive `readEnvelopeBody`'s error extraction before the modal
          // ever sees it, and only this path exercises that.
          status: 409,
          error: serverMessage,
          respond: () => ({}),
        })}
      />
    );

    const nameInput =
      await screen.findByLabelText<HTMLInputElement>(NAME_FIELD_LABEL);
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed by the admin");
    await user.type(
      screen.getByLabelText<HTMLTextAreaElement>(DESCRIPTION_LABEL),
      draftDescription
    );

    await user.click(screen.getByRole("button", { name: SUBMIT_LABEL }));

    // The message shares no words with the "Failed to promote component."
    // fallback, so this cannot pass on a swallowed server message.
    await screen.findByText(serverMessage);
    // The request was actually issued — this is the server-rejection path, not
    // the client-side blank-name guard covered above.
    expect(captured).toHaveLength(1);
    expect(screen.queryByText(SUCCESS_MESSAGE)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText<HTMLInputElement>(NAME_FIELD_LABEL).value
    ).toBe("Renamed by the admin");
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(DESCRIPTION_LABEL).value
    ).toBe(draftDescription);
  });
});

describe("PromoteModal in-flight state (ISS-6639)", () => {
  it("disables Cancel and Submit while the promote is in flight", async () => {
    const user = userEvent.setup();
    let settle: ((result: PromoteResponse) => void) | undefined;
    const inFlight = new Promise<PromoteResponse>((resolve) => {
      settle = resolve;
    });
    render(
      <SubmitHarness
        component={makeComponent()}
        route={createCapturingPromoteRoute([], { respond: () => inFlight })}
      />
    );

    await screen.findByLabelText(NAME_FIELD_LABEL);
    await user.click(screen.getByRole("button", { name: SUBMIT_LABEL }));

    // Label and `disabled` are two separate bindings off `promote.isPending`;
    // reading only the label would pass with the guard dropped, leaving a
    // double-click free to fire a second org-wide distribution.
    const pendingSubmit = await screen.findByRole("button", {
      name: PENDING_SUBMIT_LABEL,
    });
    expect(pendingSubmit).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    settle?.(PROMOTE_RESULT);
    await screen.findByText(SUCCESS_MESSAGE);
  });
});

const SUBMIT_LABEL = "Promote & Distribute";
const PENDING_SUBMIT_LABEL = "Promoting…";

const PROMOTE_RESULT: PromoteResponse = {
  catalogItemId: "catalog-item-1",
  distributionId: "distribution-1",
};

/**
 * A promote route that records every request body it is handed.
 *
 * The plain `promoteRoute` above answers success no matter what was sent, so a
 * test that only waits for the success screen cannot tell a correct body from
 * an empty one — and this endpoint auto-installs the promoted component on
 * every compute target in the org. These tests assert the captured body.
 */
function createCapturingPromoteRoute(
  captured: unknown[],
  overrides: Partial<Omit<FixtureRoute, "method" | "path">> = {}
): FixtureRoute {
  const respond: (context: FixtureRequestContext) => unknown =
    overrides.respond ?? (() => PROMOTE_RESULT);
  return {
    ...overrides,
    method: "POST",
    path: "/agent-components/promote",
    respond: (context) => {
      captured.push(context.body);
      return respond(context);
    },
  };
}

/**
 * Mounts the modal open with a caller-supplied route so a test can capture the
 * outbound request, defer the response, or reject it.
 */
function SubmitHarness({
  component,
  route,
}: {
  component: AgentComponent;
  route: FixtureRoute;
}) {
  return (
    <AppCoreStoryProviders apiRoutes={[route]}>
      <PromoteModal
        component={component}
        onOpenChange={() => {
          // The submit path is what's under test; dismissal is covered above.
        }}
        open={true}
      />
    </AppCoreStoryProviders>
  );
}
