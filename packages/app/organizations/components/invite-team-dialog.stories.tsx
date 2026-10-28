import type {
  InviteMembersInput,
  InviteMembersResponse,
} from "@repo/api/src/types/onboarding";
import { InviteMemberStatus } from "@repo/api/src/types/onboarding";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { InviteTeamDialog } from "./invite-team-dialog";

/**
 * The shared "Invite your team" dialog (PRD-532 §5.4 / M9): multi-row email
 * composer, real Clerk invitations via `POST /organizations/invitations`
 * (`useInviteMembers`). Rendered by both the web onboarding spotlight
 * (`invite-spotlight-host.tsx`) and the desktop sidebar spotlight
 * (`invite-spotlight.tsx`), so this story owns the one dialog both surfaces
 * mount rather than either surface owning a private fixture of it.
 *
 * Every story renders the dialog OPEN via the controlled `open` prop rather
 * than a trigger, since a trigger has nothing to click without a surface's own
 * chrome around it.
 */
const SEND_ONE_BUTTON_NAME = "Send 1 invitation";
const FIRST_EMAIL = "diego@brightloop.dev";
const SECOND_EMAIL = "sana@brightloop.dev";
const REJECTED_EMAIL = "priya.nair@northlane.io";

// Matches either the plain single-row label ("Email address") or the
// row-numbered variant ("Email address, row 2") that appears once a second
// row exists — see AddAndRemoveRows below.
const EMAIL_ADDRESS_LABEL_PATTERN = /^Email address/;
const REMOVE_EMAIL_ROW_BUTTON_PATTERN = /^Remove email row/;

const meta = {
  title: "Composites v1.0/Organizations/Invite Team Dialog",
  component: InviteTeamDialog,
  tags: ["deprecated", "autodocs"],
  args: {
    open: true,
  },
} satisfies Meta<typeof InviteTeamDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The dialog as it first opens: one empty row, Send disabled with no valid email yet. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await expect(await body.findByRole("dialog")).toBeVisible();
    await expect(body.getByText("Invite your team")).toBeVisible();
    await expect(body.getAllByLabelText("Email address")).toHaveLength(1);
    await expect(
      body.getByRole("button", { name: "Send invitations" })
    ).toBeDisabled();
  },
};

/**
 * Adding a second row, filling both, then removing the first — the remaining
 * row keeps ITS OWN value (rows are keyed by id, not index) and the trailing
 * "Remove email row" control disappears again once only one row is left.
 *
 * Once a second row exists each row's aria-label gets a distinguishing row
 * number ("Email address, row 1" / "row 2"), so a screen reader can tell them
 * apart — hence the `/^Email address/` / `/^Remove email row/` patterns below
 * rather than the exact single-row label.
 */
export const AddAndRemoveRows: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const rows = () => body.getAllByLabelText(EMAIL_ADDRESS_LABEL_PATTERN);

    await userEvent.click(body.getByRole("button", { name: "Add another" }));
    await expect(rows()).toHaveLength(2);
    await expect(
      body.getByLabelText("Email address, row 1")
    ).toBeInTheDocument();
    await expect(
      body.getByLabelText("Email address, row 2")
    ).toBeInTheDocument();

    await userEvent.type(rows()[0], FIRST_EMAIL);
    await userEvent.type(rows()[1], SECOND_EMAIL);
    await expect(
      body.getByRole("button", { name: "Send 2 invitations" })
    ).toBeEnabled();

    const removeButtons = body.getAllByRole("button", {
      name: REMOVE_EMAIL_ROW_BUTTON_PATTERN,
    });
    await userEvent.click(removeButtons[0]);

    await expect(rows()).toHaveLength(1);
    await expect(rows()[0]).toHaveValue(SECOND_EMAIL);
    // Back to a single row, so the label drops the row number again — same
    // "Email address" the Default story asserts.
    await expect(body.getByLabelText("Email address")).toBeInTheDocument();
    await expect(
      body.queryAllByRole("button", { name: REMOVE_EMAIL_ROW_BUTTON_PATTERN })
    ).toHaveLength(0);
    await expect(
      body.getByRole("button", { name: SEND_ONE_BUTTON_NAME })
    ).toBeEnabled();
  },
};

/**
 * The send is in flight against a mutation that never settles: the input, the
 * add-row control, and the send button all disable together, and the button
 * keeps its count label while swapping its icon for a spinner.
 */
export const Sending: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "POST",
          path: "/organizations/invitations",
          respond: neverSettles,
        },
      ] satisfies FixtureRoute[],
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const emailInput = body.getByLabelText("Email address");
    await userEvent.type(emailInput, REJECTED_EMAIL);

    const sendButton = body.getByRole("button", {
      name: SEND_ONE_BUTTON_NAME,
    });
    await userEvent.click(sendButton);

    await waitFor(() => expect(sendButton).toBeDisabled());
    await expect(emailInput).toBeDisabled();
    await expect(
      body.getByRole("button", { name: "Add another" })
    ).toBeDisabled();
    await expect(
      canvasElement.ownerDocument.body.querySelector(".animate-spin")
    ).toBeInTheDocument();
  },
};

/**
 * The route returns 200 even when Clerk rejects individual emails
 * (per-email `status: "failed"`) — the dialog inspects the batch outcome
 * rather than assuming a 2xx means every invite landed. The failed address
 * stays in its row so the reader can fix and resend, rather than the dialog
 * resetting and losing it.
 */
export const InvitesRejected: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "POST",
          path: "/organizations/invitations",
          respond: rejectAllInvites,
        },
      ] satisfies FixtureRoute[],
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const emailInput = body.getByLabelText("Email address");
    await userEvent.type(emailInput, REJECTED_EMAIL);
    await userEvent.click(
      body.getByRole("button", { name: SEND_ONE_BUTTON_NAME })
    );

    await expect(
      await body.findByText(`Failed to invite: ${REJECTED_EMAIL}`)
    ).toBeVisible();
    await expect(emailInput).toHaveValue(REJECTED_EMAIL);
  },
};

/** A mutation that never resolves, for the sending-in-flight story. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** Every submitted address comes back rejected, on an otherwise-200 response. */
function rejectAllInvites({ body }: { body: unknown }): InviteMembersResponse {
  const input = (body ?? {}) as InviteMembersInput;
  return {
    invited: 0,
    results: input.emailAddresses.map((email) => ({
      email,
      reason: "Domain not allowed by this organization's SSO policy.",
      status: InviteMemberStatus.Failed,
    })),
  };
}
