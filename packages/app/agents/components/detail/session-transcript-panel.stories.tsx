import type {
  TranscriptAccessResponse,
  TranscriptAvailabilitySummary,
  TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import {
  TranscriptAvailability,
  TranscriptSkipReason,
} from "@repo/api/src/types/desktop-transcripts";
import {
  createNormalizedSession,
  type NormalizedSession,
} from "@repo/lib/harness/types";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { TRACE_END_OF_READ_NOTE } from "../../../shared/lib/trace-truncation-copy";
import type { TranscriptBytesTransport } from "../../data-source/transcript-bytes-transport";
import { TranscriptBytesTransportProvider } from "../../data-source/transcript-bytes-transport";
import { agentSessionKeys } from "../../hooks/use-agent-sessions";
import { TranscriptFetchError } from "../../lib/parse-transcript";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../../lib/session-transcript-href";
import {
  createAgentSessionDetailFixture,
  truncatedEventsAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "./session-transcript-panel";

const SESSION_ID = "session-detail-1";
const TRANSCRIPT_ROUTE = `/agent-sessions/${SESSION_ID}/transcript`;
/** Archive identity; folded into the parsed-file query key by the read hook. */
const TRANSCRIPT_SHA = "a".repeat(64);
/**
 * A guaranteed-unresolvable host (RFC 2606). The readable stories seed the
 * parsed result into the cache, so this URL is never fetched. It exists so a
 * query key that drifted out of alignment fails locally and loudly rather than
 * reaching S3 from a headless run.
 */
const TRANSCRIPT_URL = "https://transcripts.invalid/main.jsonl";
/** 40 MiB, comfortably over the 25 MiB auto-load cap. */
const OVERSIZED_BYTES = 40 * 1024 * 1024;

const RETRY_BUTTON_NAME = "Retry";
const LOAD_FULL_BUTTON_NAME = "Load full transcript";
const FORCE_ARCHIVE_BUTTON_NAME = "Sync this transcript anyway";

/** Human text on the parsed archive, asserted by the readable stories. */
const TRANSCRIPT_PROMPT_TEXT =
  "Reconcile the reaped lanes against the watchdog";

/** Counts descriptor reads so the Retry story can prove the button refetched. */
const uploadFailedAccessSpy = fn();

/**
 * A parsed archive with one human turn, one agent turn, and one tool call.
 * Enough for the projection to emit the row kinds the readable states need, and
 * small enough to read at a glance.
 */
const PARSED_TRANSCRIPT: NormalizedSession = createNormalizedSession({
  sessionId: SESSION_ID,
  name: "Archived cloud transcript",
  model: "claude-opus-4-8",
  startedAt: "2026-06-10T12:00:00.000Z",
  endedAt: "2026-06-10T12:04:00.000Z",
  messages: [
    {
      role: "human",
      timestamp: "2026-06-10T12:00:00.000Z",
      text: TRANSCRIPT_PROMPT_TEXT,
    },
    {
      role: "assistant",
      timestamp: "2026-06-10T12:03:00.000Z",
      text: "All 24 reaped lanes hit the 600s watchdog; none was load-related.",
      model: "claude-opus-4-8",
    },
  ],
  toolUses: [
    {
      name: "Bash",
      timestamp: "2026-06-10T12:01:00.000Z",
      input: "rg --json 'watchdog' .closedloop-ai/runs",
      output: "24 matches across 24 run directories",
    },
  ],
});

/**
 * The desktop byte transport. The cloud copy is not readable yet and this story
 * set does not exercise an on-disk read, so the resolve rejects: the panel's
 * local-fallback branch is reached by the parse producing nothing, which is
 * exactly how it is reached in the app.
 */
const desktopTransport: TranscriptBytesTransport = {
  supportsLocalFallback: true,
  resolveFetchUrl: () =>
    Promise.reject(
      new TranscriptFetchError(404, "No local transcript in this story.")
    ),
};

const desktopTransportDecorator: Decorator = (Story) => (
  <TranscriptBytesTransportProvider transport={desktopTransport}>
    <Story />
  </TranscriptBytesTransportProvider>
);

/** One per-file availability summary, as the session detail carries it. */
function transcriptSummary(
  overrides: Partial<TranscriptAvailabilitySummary> = {}
): TranscriptAvailabilitySummary {
  return {
    fileKey: MAIN_TRANSCRIPT_FILE_KEY,
    availability: TranscriptAvailability.Available,
    uploadedAt: "2026-06-10T12:20:00.000Z",
    permanentFailureReason: null,
    ...overrides,
  };
}

/**
 * One read descriptor. A readable copy (`available` / `stale`) carries the
 * signed URL, size, and archive identity; every other availability carries
 * none of them, which is what makes the file unreadable and drives the states
 * below.
 */
function transcriptDescriptor(
  overrides: Partial<TranscriptFileDescriptor> = {}
): TranscriptFileDescriptor {
  const availability =
    overrides.availability ?? TranscriptAvailability.Available;
  const isReadable =
    availability === TranscriptAvailability.Available ||
    availability === TranscriptAvailability.Stale;
  return {
    fileKey: MAIN_TRANSCRIPT_FILE_KEY,
    availability,
    url: isReadable ? TRANSCRIPT_URL : null,
    byteSize: isReadable ? 512 * 1024 : null,
    rawSha256: isReadable ? TRANSCRIPT_SHA : null,
    uploadedAt: isReadable ? "2026-06-10T12:20:00.000Z" : null,
    lastObservedAt: "2026-06-10T12:19:00.000Z",
    permanentFailureReason: null,
    ...overrides,
  };
}

/** A cloud-parseable session reporting one archived `main` transcript. */
function cloudSessionFixture(
  overrides: Parameters<typeof createAgentSessionDetailFixture>[0] = {}
) {
  return createAgentSessionDetailFixture({
    harness: "claude",
    model: "claude-opus-4-8",
    primaryModel: "claude-opus-4-8",
    transcripts: [transcriptSummary()],
    ...overrides,
  });
}

/**
 * Seed the descriptor read. Both halves are needed: `queryData` paints the
 * state on the first frame, and the route answers the refetch the descriptor
 * query always makes on mount (its signed URLs are short-lived, so it never
 * trusts a cached copy) with the same payload.
 */
function accessParameters(
  files: TranscriptFileDescriptor[],
  onRequest?: () => void
) {
  const response: TranscriptAccessResponse = { sessionId: SESSION_ID, files };
  return {
    appCore: {
      queryData: [
        [agentSessionKeys.transcriptAccess(SESSION_ID), response] as const,
      ],
      apiRoutes: [
        {
          method: "GET",
          path: TRANSCRIPT_ROUTE,
          respond: () => {
            onRequest?.();
            return response;
          },
        },
      ],
    },
  };
}

/**
 * Seed the descriptor read AND the parsed result, so the panel paints rows
 * without a fetch. The parsed entry is keyed by the descriptor's `rawSha256`
 * (a re-upload mints a new key), and the hour-long trust window on that key is
 * what stops the query re-parsing on mount.
 */
function parsedTranscriptParameters(availability: TranscriptAvailability) {
  const base = accessParameters([transcriptDescriptor({ availability })]);
  return {
    appCore: {
      ...base.appCore,
      queryData: [
        ...base.appCore.queryData,
        [
          agentSessionKeys.transcriptFile(
            SESSION_ID,
            MAIN_TRANSCRIPT_FILE_KEY,
            TRANSCRIPT_SHA
          ),
          { kind: "parsed", session: PARSED_TRANSCRIPT },
        ] as const,
      ],
    },
  };
}

/**
 * ISS-5698: the transcript panel decides what a reader is told when there are
 * no rows, and the four answers it has to keep apart (still loading, nothing
 * recorded, not readable yet, never coming) are exactly the ones that collapse
 * into each other when nobody looks at them side by side. Every story below
 * pins one of those answers, or one of the two ways rows DO arrive: the parsed
 * cloud archive, and the desktop's local projection.
 *
 * Each seeds its read through `parameters.appCore`: the descriptor response
 * under `agentSessionKeys.transcriptAccess`, and for the row-painting stories
 * the parsed result under `agentSessionKeys.transcriptFile`. Nothing here
 * touches the network.
 */
const meta = {
  title: "App Core/Agents/Session Transcript Panel",
  component: SessionTranscriptPanel,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    session: cloudSessionFixture(),
  },
} satisfies Meta<typeof SessionTranscriptPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Descriptors have not arrived yet. The skeleton carries `aria-busy`, so this
 * reads as "we are still asking" to a screen reader as well as to the eye.
 *
 * Pinned by a route that never settles, because the state is otherwise a single
 * frame. Read it against {@link NoTranscript}: those two must never look alike,
 * and they are the pair most often conflated.
 */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: TRANSCRIPT_ROUTE,
          respond: () => new Promise<never>(() => undefined),
        },
      ],
    },
  },
  play: ({ canvasElement }) => {
    expect(canvasElement.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(canvasElement.textContent).not.toContain("No transcript");
  },
};

/**
 * The session reports no transcript at all, so the read never starts. A
 * settled, genuine nothing: no spinner, and no Retry, because nothing failed.
 */
export const NoTranscript: Story = {
  args: { session: createAgentSessionDetailFixture({ harness: "claude" }) },
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvasElement.textContent).toContain("No transcript");
    expect(canvasElement.querySelector('[aria-busy="true"]')).toBeNull();
    expect(
      canvas.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).toBeNull();
  },
};

/**
 * The archive knows about the file and the source machine is still uploading
 * it. Distinct from {@link Loading}: this one is settled, and the wait is on
 * another machine. It offers no Retry, because nothing here failed.
 */
export const UploadPending: Story = {
  parameters: accessParameters([
    transcriptDescriptor({
      availability: TranscriptAvailability.UploadPending,
    }),
  ]),
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvasElement.textContent).toContain("Transcript still syncing");
    expect(
      canvas.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).toBeNull();
  },
};

/**
 * The last upload attempt failed. It is retryable, so this is the first state
 * here that offers a button. The `play` proves the button actually re-reads the
 * descriptors rather than merely existing, which is the regression a screenshot
 * cannot catch.
 */
export const UploadFailed: Story = {
  parameters: accessParameters(
    [
      transcriptDescriptor({
        availability: TranscriptAvailability.UploadFailed,
      }),
    ],
    uploadFailedAccessSpy
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvasElement.textContent).toContain("Transcript upload failed");

    const before = uploadFailedAccessSpy.mock.calls.length;
    await userEvent.click(
      canvas.getByRole("button", { name: RETRY_BUTTON_NAME })
    );
    await waitFor(() =>
      expect(uploadFailedAccessSpy.mock.calls.length).toBeGreaterThan(before)
    );
  },
};

/**
 * A hard dead end: the file exceeded the archive size cap, so the automatic
 * lane will never carry it. Titled "not archived", and offering no Retry
 * because a retry could only fail.
 *
 * The force-archive override is desktop-only, so the web transport renders no
 * button and the description alone carries the way out. The `play` pins that
 * absence: a permanently disabled button beside a duplicate explanation is the
 * shape this deliberately does not have.
 */
export const PermanentlyUnavailable: Story = {
  parameters: accessParameters([
    transcriptDescriptor({
      availability: TranscriptAvailability.PermanentlyUnavailable,
      permanentFailureReason: TranscriptSkipReason.TooLarge,
    }),
  ]),
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvasElement.textContent).toContain("Transcript not archived");
    expect(canvasElement.textContent).toContain("archive size limit");
    expect(
      canvas.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).toBeNull();
    expect(
      canvas.queryByRole("button", { name: FORCE_ARCHIVE_BUTTON_NAME })
    ).toBeNull();
  },
};

/**
 * The same terminal frame on a RECOVERABLE reason: a batch-materialized source
 * that was not ready this sweep and can be regenerated on the next one.
 *
 * The pair with {@link PermanentlyUnavailable} is the point: identical
 * plumbing, and the headline still must not read as a dead end. Which reasons
 * are recoverable is read from the shared wire contract, so this story showing
 * "not archived" would mean that lookup stopped reaching the renderer.
 */
export const PermanentlyUnavailableRecoverable: Story = {
  parameters: accessParameters([
    transcriptDescriptor({
      availability: TranscriptAvailability.PermanentlyUnavailable,
      permanentFailureReason:
        TranscriptSkipReason.MaterializedSourceUnavailable,
    }),
  ]),
  play: ({ canvasElement }) => {
    expect(canvasElement.textContent).toContain("Transcript still syncing");
    expect(canvasElement.textContent).not.toContain("Transcript not archived");
  },
};

/**
 * Nothing has ever synced for this session. Named for the harness rather than
 * said generically, so the reader knows which machine owes the upload.
 */
export const NeverSynced: Story = {
  parameters: accessParameters([
    transcriptDescriptor({ availability: TranscriptAvailability.Missing }),
  ]),
  play: ({ canvasElement }) => {
    expect(canvasElement.textContent).toContain("No Claude transcript");
  },
};

/**
 * An archived transcript exists, but no in-browser parser handles this harness
 * yet. Stated as a renderer gap rather than a missing transcript, because the
 * file is there and we just cannot draw it. Those are different problems for
 * different people.
 */
export const UnsupportedHarness: Story = {
  args: { session: cloudSessionFixture({ harness: "cursor" }) },
  parameters: accessParameters([transcriptDescriptor()]),
  play: ({ canvasElement }) => {
    expect(canvasElement.textContent).toContain(
      "Transcript rendering unavailable"
    );
    expect(canvasElement.textContent).toContain("cursor");
  },
};

/**
 * The descriptor read itself failed. Retryable, and worded as a fetch gap that
 * a fresh signed URL may recover. That is deliberately NOT the parse-failure
 * wording, because a parse failure re-fetches the same bytes and fails the same
 * way.
 */
export const FetchFailed: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: TRANSCRIPT_ROUTE,
          respond: () => ({}),
          status: 500,
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: RETRY_BUTTON_NAME });
    expect(canvasElement.textContent).toContain("Couldn't load transcript");
    expect(canvasElement.textContent).not.toContain("couldn't be parsed");
  },
};

/**
 * A file over the 25 MiB auto-load cap, held behind an explicit load instead of
 * downloading on sight.
 *
 * The size is the load-bearing part: the gate exists so the reader can decide,
 * and that cannot be decided against "this transcript is large". The `play`
 * pins the rendered figure, because `formatBytes` falling back to "an unknown
 * size" where a real one was available would still look like a fine gate.
 *
 * Taking the gate is not exercised: it starts a real archive download, which is
 * not something a headless story run should do.
 */
export const OversizedGate: Story = {
  parameters: accessParameters([
    transcriptDescriptor({ byteSize: OVERSIZED_BYTES }),
  ]),
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvasElement.textContent).toContain("40 MB");
    expect(
      canvas.getByRole("button", { name: LOAD_FULL_BUTTON_NAME })
    ).toBeVisible();
  },
};

/**
 * The ordinary web path: the archived transcript parsed, and its turns are the
 * trace. No notice above it, because the copy is current and there is nothing
 * to caveat.
 *
 * The session ALSO carries `eventsTruncated`, which is what makes the missing
 * end-of-read footer meaningful. That flag describes the DB event read, and a
 * parsed archive is read whole, so the note would claim these rows stop early
 * when they do not. {@link LocalProjectionTruncated} is the same flag over the
 * source it actually describes, and does print it.
 */
export const LoadedTranscript: Story = {
  args: { session: cloudSessionFixture({ eventsTruncated: true }) },
  parameters: parsedTranscriptParameters(TranscriptAvailability.Available),
  play: ({ canvasElement }) => {
    expect(canvasElement.textContent).toContain(TRANSCRIPT_PROMPT_TEXT);
    expect(canvasElement.textContent).not.toContain(TRACE_END_OF_READ_NOTE);
    expect(canvasElement.querySelector('[aria-busy="true"]')).toBeNull();
  },
};

/**
 * The same parsed archive flagged `stale`: the freshest uploaded bytes, but the
 * source machine has recorded activity since.
 *
 * The notice sits ABOVE the rows and does not replace them, since a caveat that
 * hid the content would be worse than the staleness it warns about. It is a
 * design-system `Alert`, so the warning is announced rather than only tinted.
 */
export const StaleTranscript: Story = {
  parameters: parsedTranscriptParameters(TranscriptAvailability.Stale),
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("alert").textContent).toContain(
      "newer local activity has not synced yet"
    );
    expect(canvasElement.textContent).toContain(TRANSCRIPT_PROMPT_TEXT);
  },
};

/**
 * The desktop-local path on a truncated read: no transcript context, so the
 * panel paints the session's own DB projection, the one source the event read
 * cap actually cuts. It discloses that cut at the END of the rows, where a
 * reader scrolling a long trace meets it.
 */
export const LocalProjectionTruncated: Story = {
  args: {
    session: truncatedEventsAgentSessionDetailFixture,
    fallbackItems: truncatedEventsAgentSessionDetailFixture.turnItems,
  },
  play: ({ canvasElement }) => {
    expect(canvasElement.textContent).toContain(TRACE_END_OF_READ_NOTE);
    expect(canvasElement.querySelector(".st-msg")).not.toBeNull();
  },
};

/**
 * The desktop serving its on-disk copy while the cloud upload is still in
 * flight. Unreachable on the web, where the cloud states are authoritative and
 * suppress the projection, so it needs the desktop byte transport injected.
 * That is what makes the read a LOCAL one and lets the projected trace
 * through.
 *
 * What to look at: the notice explains WHY these rows are the ones on screen,
 * and is toned muted rather than warning. An upload in flight is not trouble,
 * and shouting about it teaches the reader to ignore the tone that matters.
 */
export const DesktopLocalCopy: Story = {
  args: {
    session: cloudSessionFixture({
      transcripts: [
        transcriptSummary({
          availability: TranscriptAvailability.UploadPending,
        }),
      ],
    }),
    fallbackItems: truncatedEventsAgentSessionDetailFixture.turnItems,
  },
  decorators: [desktopTransportDecorator],
  parameters: accessParameters([]),
  play: ({ canvasElement }) => {
    expect(canvasElement.textContent).toContain(
      "showing the last recorded trace"
    );
    expect(canvasElement.querySelector(".st-msg")).not.toBeNull();
  },
};
