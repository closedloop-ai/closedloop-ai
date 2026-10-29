import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import type { Meta, StoryObj } from "@storybook/react";
import { AlertCircleIcon } from "lucide-react";
import { NewDocumentDialogShell } from "./new-document-dialog-shell";

/**
 * The one-field New Document dialog, in each state the two arms of the
 * `documents-create-failure-recovery` gate can put it in (ISS-8938).
 *
 * Three of the four below only exist after a create has been REJECTED, so they
 * are not states a reviewer can reach by clicking around a running app — and the
 * two failure states differ only in copy and height, which is exactly the
 * difference a unit test cannot see. Read them as a column: a refusal and a
 * client deadline must not look like the same event, and the remediation list
 * must not push the field and footer into a crowded dialog at narrow widths.
 */
const FAILURE_ALERT_ID = "new-document-create-failure";

const meta = {
  title: "Composites v1.0/Documents/New Document Dialog Shell",
  tags: ["deprecated"],
  component: NewDocumentDialogShell,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: () => undefined,
    onDismiss: () => undefined,
    title: "",
    onTitleChange: () => undefined,
    onSubmit: (event) => event.preventDefault(),
    isSaving: false,
    submitLabel: "Create Document",
  },
} satisfies Meta<typeof NewDocumentDialogShell>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Opened, nothing typed: submit is unreachable until a title exists. */
export const Idle: Story = {};

/** A title is typed and the dialog is submittable. */
export const Ready: Story = {
  args: { title: "Team Handbook" },
};

/**
 * Mid-create. Both dismissals are shut — Cancel disabled here, Escape and
 * outside-click ignored by the shell — because the POST cannot be recalled and
 * a late success must not navigate a user who thinks they cancelled.
 */
export const Saving: Story = {
  args: { title: "Team Handbook", isSaving: true },
};

/**
 * The create was refused. The typed title is still there, the server's own
 * sentence is the body, and the submit control says what it now does.
 */
export const Refused: Story = {
  args: {
    title: "Team Handbook",
    submitLabel: "Try again",
    failureId: FAILURE_ALERT_ID,
    failure: (
      <Alert id={FAILURE_ALERT_ID} variant="error">
        <AlertCircleIcon />
        <AlertTitle>Couldn't create this document</AlertTitle>
        <AlertDescription>
          Only admins can create documents here
        </AlertDescription>
      </Alert>
    ),
  },
};

/**
 * The client stopped waiting. Deliberately NOT the state above: nothing is known
 * to have failed, so the heading does not claim it did and the canonical
 * remediation leads with checking whether the create actually landed. This is
 * the tallest state the dialog has — the one worth looking at narrow.
 */
export const TimedOut: Story = {
  args: {
    title: "Team Handbook",
    submitLabel: "Try again",
    failureId: FAILURE_ALERT_ID,
    failure: (
      <Alert id={FAILURE_ALERT_ID} variant="error">
        <AlertCircleIcon />
        <AlertTitle>We stopped waiting</AlertTitle>
        <AlertDescription>
          This took longer than expected, so we stopped waiting for a response.
          It may still be finishing.
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Give it a moment, then refresh to see whether it completed.</li>
            <li>Try again if nothing changed.</li>
          </ul>
        </AlertDescription>
      </Alert>
    ),
  },
};
