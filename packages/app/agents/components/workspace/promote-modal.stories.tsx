import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { PromoteResponse } from "@repo/api/src/types/distribution";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { makeComponent } from "./agent-component-fixtures";
import { PromoteModal } from "./promote-modal";

/**
 * The real admin dialog behind "Promote to Catalog" on the ranked-components
 * leaderboard (T-17.4 / AC-023) — POST /agent-components/promote, run through
 * its own `useMutation`, not stubbed. The route is seeded per story via
 * `parameters.appCore.apiRoutes`, the same fixture-transport seam
 * `session-transcript-panel.stories.tsx` uses for its mutation states.
 *
 * `component` is the discovered candidate the ranked leaderboard row hands the
 * dialog; the Name field prefills from it on open (see the component's own
 * ISS-5976 note on why that prefill is keyed on the open cycle, not identity).
 *
 * `DialogContent` renders through a Radix `Portal` into `document.body`, a
 * sibling of the story root rather than a descendant, so every `play` here
 * queries `canvasElement.ownerDocument.body` rather than `canvasElement` — the
 * same scoping the portaled tooltip in
 * `related-sessions-table-cell.stories.tsx` needs.
 */

const CANDIDATE = makeComponent({
  id: "uuid-pr-review-skill",
  slug: "skill::pr-review",
  name: "pr-review",
  kind: AgentComponentKind.Skill,
});

const PROMOTE_ROUTE = "/agent-components/promote";
const SUBMIT_BUTTON_NAME = "Promote & Distribute";
const PENDING_BUTTON_NAME = "Promoting…";
const DUPLICATE_NAME_ERROR = "A catalog item named 'pr-review' already exists.";
const SUCCESS_RESULT = {
  catalogItemId: "catalog_pr-review-skill",
  distributionId: "dist_pr-review-skill",
} satisfies PromoteResponse;

const meta = {
  title: "Composites v1.0/Agents/Workspace/Promote Modal",
  component: PromoteModal,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: {
    component: CANDIDATE,
    open: true,
    onOpenChange: fn(),
    onSuccess: fn(),
  },
} satisfies Meta<typeof PromoteModal>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The starting state for a real candidate: Name prefilled from the discovered
 * component, Description blank, no result yet.
 */
export const Prefilled: Story = {};

/**
 * No candidate selected. The prefill effect only runs when `component` is
 * present, so Name stays genuinely blank rather than showing stale text from a
 * previous candidate — the state a caller reaches by opening the dialog
 * without a row selected.
 */
export const Empty: Story = {
  args: { component: null },
};

/**
 * The mutation is in flight: both buttons disable and the submit label swaps
 * to "Promoting…", so a second click can't fire a duplicate request.
 */
export const PendingSubmit: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "POST",
          path: PROMOTE_ROUTE,
          respond: () => new Promise<never>(() => undefined),
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    // Portaled into `document.body` (see the file doc comment above).
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole("button", { name: SUBMIT_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: PENDING_BUTTON_NAME })
      ).toBeDisabled()
    );
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeDisabled();
  },
};

/**
 * Client-side validation: an admin clears the required Name field and submits
 * anyway. Caught before the request ever fires — no `POST` route is even
 * registered for this story.
 */
export const ValidationError: Story = {
  play: async ({ canvasElement }) => {
    // Portaled into `document.body` (see the file doc comment above).
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.clear(canvas.getByLabelText("Name"));
    await userEvent.click(
      canvas.getByRole("button", { name: SUBMIT_BUTTON_NAME })
    );
    await expect(canvas.getByText("Name is required.")).toBeInTheDocument();
  },
};

/**
 * The server refuses the promotion — e.g. a catalog item with this name
 * already exists. The dialog stays open on the form with the server's own
 * message, so the admin can rename and retry without losing their edits.
 */
export const ApiError: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "POST",
          path: PROMOTE_ROUTE,
          respond: () => ({}),
          status: 409,
          error: DUPLICATE_NAME_ERROR,
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    // Portaled into `document.body` (see the file doc comment above).
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole("button", { name: SUBMIT_BUTTON_NAME })
    );
    await expect(
      await canvas.findByText(DUPLICATE_NAME_ERROR)
    ).toBeInTheDocument();
  },
};

/**
 * The promotion lands: the form is replaced with the created identifiers and a
 * "Done" action, and `onSuccess` fires with the same result so the caller can
 * refresh the leaderboard behind the dialog.
 */
export const Success: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "POST",
          path: PROMOTE_ROUTE,
          respond: () => SUCCESS_RESULT,
        },
      ],
    },
  },
  play: async ({ args, canvasElement }) => {
    // Portaled into `document.body` (see the file doc comment above).
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole("button", { name: SUBMIT_BUTTON_NAME })
    );
    await expect(
      await canvas.findByText(SUCCESS_RESULT.catalogItemId)
    ).toBeInTheDocument();
    await expect(
      canvas.getByText(SUCCESS_RESULT.distributionId)
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(args.onSuccess).toHaveBeenCalledWith(SUCCESS_RESULT)
    );
  },
};
