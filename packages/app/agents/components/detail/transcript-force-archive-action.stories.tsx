import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type {
  ForceArchiveOversizedResult,
  TranscriptBytesTransport,
} from "../../data-source/transcript-bytes-transport";
import { TranscriptBytesTransportProvider } from "../../data-source/transcript-bytes-transport";
import { TranscriptForceArchiveAction } from "./transcript-force-archive-action";

/**
 * ISS-5698: the "Sync this transcript anyway" override (FEA-3489 / PRD-536),
 * across every outcome its mutation can settle on.
 *
 * This control is the whole recovery path for a transcript the automatic lane
 * dead-lettered, and every one of its six results is a DIFFERENT promise to the
 * reader: retry now, retry later, never, or nothing to do. Four of them look
 * like the same inline notice at a glance, so the matrix has to be seen rather
 * than asserted:
 *
 *  - **readable now** (`uploaded` + caught up, `noop`). No notice at all,
 *    because the panel behind this action is about to re-render the transcript.
 *    Silence is correct here and only here.
 *  - **started, not landed** (`uploaded`, not caught up). A MUTED notice. The
 *    upload is healthy; styling it destructive would report a failure that did
 *    not happen.
 *  - **retryable** (`failed`) vs **terminal** (`permanent`). Both warn, and the
 *    only difference is whether the copy invites another attempt. Getting that
 *    backwards either strands a recoverable transcript or sends the user into a
 *    loop against a dead end.
 *  - **not applicable** (`unavailable`, `notFound`). Settled, not an error.
 *
 * The transport is the injection seam, exactly as `apiRoutes` is for reads: the
 * component runs its real `useMutation` against whatever
 * `TranscriptBytesTransportProvider` supplies, which is how the desktop renderer
 * wires it in production. Nothing here stubs the component itself.
 */
const transcriptTransportDecorator: Decorator = (Story, context) => (
  <TranscriptBytesTransportProvider
    transport={
      (context.parameters.transcriptTransport ??
        webTransport()) as TranscriptBytesTransport
    }
  >
    <div className="flex justify-center">
      <Story />
    </div>
  </TranscriptBytesTransportProvider>
);

const FORCE_BUTTON_NAME = "Sync this transcript anyway";

/**
 * The Sync this transcript anyway button shown when a transcript failed to
 * archive automatically for being too large.
 */
const meta = {
  title: "Composites/Sessions/Trace/Transcript Force Archive Action",
  component: TranscriptForceArchiveAction,
  tags: ["autodocs"],
  argTypes: {
    externalSessionId: {
      control: "text",
      description:
        "Harness session id. Undefined means the local sync store has no row to aim at, so the action renders nothing.",
    },
    fileKey: {
      control: "text",
      description: "Transcript file to force: main, or subagent:{id}.",
    },
    onArchived: {
      control: false,
      description:
        "Fires only when the result means the transcript is readable now (a caught-up upload, or a server-side noop).",
      table: { category: "Events" },
    },
  },
  parameters: { layout: "padded" },
  decorators: [transcriptTransportDecorator],
  args: {
    externalSessionId: "ext-session-1",
    fileKey: "main",
    onArchived: fn(),
  },
} satisfies Meta<typeof TranscriptForceArchiveAction>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The web surface. There is no local transcript file to push, so the transport
 * supplies no `forceArchiveOversized` and the action renders NOTHING, not a
 * permanently disabled button with an explanation, which would be dead chrome
 * beside the panel description that already says the transcript can only be
 * synced from the machine where the session ran.
 */
export const WebSurfaceRendersNothing: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("button", { name: FORCE_BUTTON_NAME })
    ).not.toBeInTheDocument();
  },
};

/**
 * Desktop transport present, but the session carries no harness id. The local
 * sync store has no row to address, so the override cannot be aimed at
 * anything. It renders nothing for the same reason as the web case, and this
 * story exists because the two absences arrive down different code paths and
 * only one of them is obvious from the props.
 */
export const MissingHarnessIdentity: Story = {
  parameters: { transcriptTransport: desktopTransport(() => neverSettles()) },
  render: (args) => (
    <TranscriptForceArchiveAction
      externalSessionId={undefined}
      fileKey={args.fileKey}
      onArchived={args.onArchived}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("button", { name: FORCE_BUTTON_NAME })
    ).not.toBeInTheDocument();
  },
};

/**
 * The starting state on desktop: one enabled control, no notice. Nothing has
 * been attempted yet, so the panel says nothing about an outcome.
 */
export const Idle: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ kind: "noop" })
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    ).toBeEnabled();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

/**
 * The upload is in flight: the button is disabled and wears a spinner, and the
 * notice slot stays EMPTY. Pinned because the alternative, leaving the previous
 * result on screen while a new attempt runs, makes the panel narrate a settled
 * outcome for a request that has not settled.
 */
export const Pending: Story = {
  parameters: { transcriptTransport: desktopTransport(() => neverSettles()) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
      ).toBeDisabled()
    );
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

/**
 * The success that actually delivers: the upload finished AND the cloud copy has
 * caught up, so the transcript is readable now. `onArchived` fires to refetch the
 * descriptors, and no notice renders. The panel is about to replace this whole
 * terminal state with the rendered transcript, so a "done!" banner would
 * announce something the reader is already looking at.
 */
export const UploadedAndCaughtUp: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ caughtUp: true, kind: "uploaded" })
    ),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() => expect(args.onArchived).toHaveBeenCalled());
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

/**
 * Server-side noop: the file was already archived, so nothing was uploaded and
 * the transcript is readable. Visually identical to
 * {@link UploadedAndCaughtUp}, deliberately, because to the reader the two are
 * the same fact. It is a separate branch, though, and this story is what stops it
 * from silently becoming a no-refetch dead end.
 */
export const AlreadyArchived: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ kind: "noop" })
    ),
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() => expect(args.onArchived).toHaveBeenCalled());
  },
};

/**
 * A large transcript accepted but not yet caught up. The terminal state stays in
 * place, because there is nothing to render yet, and a MUTED notice says the
 * upload started and where it will appear. `onArchived` must NOT fire: refetching now
 * would find the same unreadable descriptor and flash the reader back to this
 * screen.
 */
export const UploadStartedNotCaughtUp: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ caughtUp: false, kind: "uploaded" })
    ),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(
        "This transcript will appear here once the upload finishes."
      )
    );
    await expect(args.onArchived).not.toHaveBeenCalled();
  },
};

/**
 * The RETRYABLE failure. The notice warns and explicitly invites another
 * attempt, and the button returns to enabled so the invitation is honest. A
 * "try again" beside a dead control is the worst of both.
 */
export const RetryableFailure: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ kind: "failed", reason: "gateway_timeout" })
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent("You can try again.")
    );
    await expect(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    ).toBeEnabled();
  },
};

/**
 * The TERMINAL failure, next to {@link RetryableFailure} so the one-sentence
 * difference is visible. Same warning tone, and no retry invitation: the
 * transcript is staying on the machine where the session ran, and the copy says
 * so instead of leaving the reader clicking.
 */
export const PermanentFailure: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ kind: "permanent", reason: "exceeds_hard_limit" })
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(
        "It will stay on the machine where the session ran."
      )
    );
  },
};

/** History sync is off or offline, so the request could not be dispatched. */
export const SyncUnavailable: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ kind: "unavailable" })
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(
        "History sync is currently unavailable."
      )
    );
  },
};

/**
 * The dead row is gone from the local queue. Settled, and NOT an error. It
 * reads in the default tone rather than a warning, which is the distinction this
 * story pins: a result that is merely informational must not be dressed as a
 * failure.
 */
export const NoLongerQueued: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.resolve({ kind: "notFound" })
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(
        "This transcript is no longer queued for syncing."
      )
    );
  },
};

/**
 * The transport REJECTS rather than returning a result, an IPC bridge that died
 * mid-call. No local notice renders: this path belongs to the global mutation
 * error handler (a toast), and a second inline explanation would say the same
 * thing twice. What this story pins is that the control recovers. The button
 * re-enables, so a transient bridge failure is not a one-way trip.
 */
export const TransportRejects: Story = {
  parameters: {
    transcriptTransport: desktopTransport(() =>
      Promise.reject(new Error("gateway bridge closed"))
    ),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: FORCE_BUTTON_NAME })
      ).toBeEnabled()
    );
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    await expect(args.onArchived).not.toHaveBeenCalled();
  },
};

/**
 * The web transport: no local file, so no `forceArchiveOversized` capability at
 * all. `resolveFetchUrl` is never reached by this component and is present only
 * to satisfy the port.
 */
function webTransport(): TranscriptBytesTransport {
  return {
    resolveFetchUrl: () =>
      Promise.resolve({
        kind: "ready",
        source: "cloud",
        url: "https://transcripts.example.com/story-fixture",
      }),
    supportsLocalFallback: false,
  };
}

/**
 * The desktop transport, whose `forceArchiveOversized` is the seam every story
 * above drives. `force` receives the real
 * `{ externalSessionId, fileKey }` the component sends.
 */
function desktopTransport(
  force: () => Promise<ForceArchiveOversizedResult>
): TranscriptBytesTransport {
  return {
    forceArchiveOversized: force,
    resolveFetchUrl: () =>
      Promise.resolve({
        kind: "ready",
        source: "local",
        url: "app://renderer/transcripts/story-fixture",
      }),
    supportsLocalFallback: true,
  };
}

/** A force-archive call that never settles, for the in-flight state. */
function neverSettles(): Promise<ForceArchiveOversizedResult> {
  return new Promise<ForceArchiveOversizedResult>(() => undefined);
}
