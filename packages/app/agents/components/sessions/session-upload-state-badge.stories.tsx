import { TRANSCRIPT_RETRY_LABEL } from "@repo/app/agents/components/detail/session-transcript-panel";
import {
  SessionSyncStatusBadge,
  type SessionUploadStateBadgeProps,
} from "@repo/app/agents/components/sessions/session-sync-status-badge";
import { SessionUploadState } from "@repo/app/shared/lib/upload-state";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";

/**
 * ISS-12532 (PRD-807): the per-session upload state, one story per state, on
 * the existing `SessionSyncStatusBadge` (its `uploadState` form). The
 * transcript-verdict form keeps its own v1.0 entry,
 * "Composites/Sessions/Session Sync Status Badge".
 *
 * The badge takes all its text as props and authors none. A shipped,
 * human-approved string is reused only where it means the same thing here
 * (AGENTS.md, Human Provenance). One does:
 *
 * - retry: `session-transcript-panel.tsx:958` (`TRANSCRIPT_RETRY_LABEL`), the
 *   same action.
 *
 * The other three shipped candidates promise something else (PR #8843
 * review), so their slots are placeholders:
 *
 * - "Local only" (`cloud-sync-state-badge.tsx`) means the session is in the
 *   desktop sync outbox and uploads on its own; here it means never shared.
 * - "Syncing" and "Sync failed" (`session-sync-status.ts`) are transcript
 *   verdicts: the session is already in the cloud and only its transcript is
 *   catching up, or failed to. Here the session itself is not shared yet.
 *
 * The shared state has no approved source at all. Placeholders here are
 * allowed by operator ruling (Nerys, 2026-10-15), ISS-12532 thread
 * th_JevBHI1iGrfI_OpGpZGUZ, until the owner supplies the wording. Proposed
 * wording for every slot is on the ticket, in ISS-12532 thread
 * th_kMO-2BQdTiJ0caM-myRWn.
 */
const STORY_LABEL: Record<SessionUploadState, string> = {
  [SessionUploadState.LocalOnly]: "Placeholder: local-only label",
  [SessionUploadState.Uploading]: "Placeholder: uploading label",
  [SessionUploadState.Shared]: "Placeholder: shared label",
  [SessionUploadState.Failed]: "Placeholder: failed label",
};
const STORY_RETRY_LABEL = TRANSCRIPT_RETRY_LABEL;

/**
 * The badge's upload-state props, flattened so the controls panel can drive
 * the failed-only retry props without the discriminated union in the way.
 * `retryLabel`, `isRetrying` and `onRetry` only take effect on Failed.
 */
type UploadStateStoryProps = {
  uploadState: SessionUploadState;
  label: string;
  retryLabel: string;
  isRetrying: boolean;
  onRetry: () => void;
};

function toBadgeProps({
  uploadState,
  label,
  retryLabel,
  isRetrying,
  onRetry,
}: UploadStateStoryProps): SessionUploadStateBadgeProps {
  return uploadState === SessionUploadState.Failed
    ? { uploadState, label, retryLabel, isRetrying, onRetry }
    : { uploadState, label };
}

function UploadStateStory(props: UploadStateStoryProps) {
  return <SessionSyncStatusBadge {...toBadgeProps(props)} />;
}

const meta = {
  title: "Composites/Artifacts/Sessions/Session Upload State Badge",
  tags: ["experimental"],
  component: UploadStateStory,
  parameters: { layout: "padded" },
  args: {
    uploadState: SessionUploadState.LocalOnly,
    label: STORY_LABEL[SessionUploadState.LocalOnly],
    retryLabel: STORY_RETRY_LABEL,
    isRetrying: false,
    onRetry: fn(),
  },
  argTypes: {
    uploadState: {
      control: "select",
      options: Object.values(SessionUploadState),
      description: "Which of the four upload states to show.",
    },
    label: {
      control: "text",
      description: "The state's visible text. Supplied by the host.",
    },
    retryLabel: {
      control: "text",
      description: "Failed only: the retry control's text.",
    },
    isRetrying: {
      control: "boolean",
      description: "Failed only: disables retry while one is in flight.",
    },
    onRetry: {
      control: false,
      description: "Failed only: the retry handler (see the Actions panel).",
    },
  },
} satisfies Meta<typeof UploadStateStory>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Local only: the session has not been shared. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(STORY_LABEL[SessionUploadState.LocalOnly])
    ).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

/** Uploading: a share was confirmed and is in flight. The dot pulses. */
export const Uploading: Story = {
  args: {
    uploadState: SessionUploadState.Uploading,
    label: STORY_LABEL[SessionUploadState.Uploading],
  },
};

/** Shared: the upload finished. */
export const Shared: Story = {
  args: {
    uploadState: SessionUploadState.Shared,
    label: STORY_LABEL[SessionUploadState.Shared],
  },
};

/** Failed: the upload did not finish. Retry hands control back to the host. */
export const Failed: Story = {
  args: {
    uploadState: SessionUploadState.Failed,
    label: STORY_LABEL[SessionUploadState.Failed],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: STORY_RETRY_LABEL })
    );
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** Failed, with a retry in flight: the control is disabled until it settles. */
export const FailedRetrying: Story = {
  args: { ...Failed.args, isRetrying: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: STORY_RETRY_LABEL })
    ).toBeDisabled();
  },
};

/** All four states side by side, the way a list of sessions would mix them. */
export const AllStates: Story = {
  render: (args) => (
    <div className="flex flex-col items-start gap-3">
      {Object.values(SessionUploadState).map((uploadState) => (
        <UploadStateStory
          {...args}
          key={uploadState}
          label={STORY_LABEL[uploadState]}
          uploadState={uploadState}
        />
      ))}
    </div>
  ),
};

export const DefaultDark: Story = { ...Default, ...DARK };

export const UploadingDark: Story = { ...Uploading, ...DARK };

export const FailedDark: Story = { ...Failed, ...DARK, play: undefined };
