"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Progress } from "@repo/design-system/components/ui/progress";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertCircleIcon,
  CloudOffIcon,
  CloudUploadIcon,
  DownloadIcon,
  Loader2Icon,
  type LucideIcon,
  MessageCircleIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo } from "react";
import { useFeatureFlagEnabledOptional } from "../../../shared/feature-flags/use-feature-flag-enabled";
import { formatBytes } from "../../../shared/lib/format-utils";
import type { TranscriptBytesSource } from "../../data-source/transcript-bytes-transport";
import { useSessionTranscript } from "../../hooks/use-session-transcript";
import { useTranscriptLoadMore } from "../../hooks/use-transcript-load-more";
import { useTranscriptTraceItems } from "../../hooks/use-transcript-trace-items";
import type { TranscriptDownloadProgress } from "../../lib/parse-transcript";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../../lib/session-transcript-href";
import { resolveSubagentCount } from "../../lib/subagent-transcripts";
import {
  buildTraceRowTranslators,
  type TraceRowTranslators,
} from "../../lib/timeline-row-space";
import { resolveTranscriptInvocationAnchorRow } from "../../lib/transcript-turn-items";
import { SessionTrace, type SessionTraceProps } from "./session-trace";
import type { SessionTraceHandle } from "./session-trace-contract";
import { useSessionTraceGutterActor } from "./session-trace-gutter-actor";
import {
  permanentUnavailableDescription,
  TRANSCRIPT_NEVER_EXPECTED_DESCRIPTION,
  TRANSCRIPT_NEVER_EXPECTED_TITLE,
  terminalUnavailablePresentation,
  transcriptNounForHarness,
} from "./session-transcript-status-copy";
import { TranscriptFileSwitcher } from "./transcript-file-switcher";
import { TranscriptForceArchiveAction } from "./transcript-force-archive-action";
import { TranscriptLoadMore } from "./transcript-load-more";

type TracePassthroughProps = Pick<
  SessionTraceProps,
  | "activeRow"
  | "highlightAnchor"
  | "invocationAnchor"
  | "onJump"
  | "onSubmitTraceComment"
  | "onTraceSelectionChange"
  | "renderGutterActor"
  | "scrollElementRef"
>;

/** What the panel hands every `SessionTrace` it paints. */
type RenderedTraceProps = TracePassthroughProps &
  Pick<SessionTraceProps, "virtualize"> & {
    ref?: RefObject<SessionTraceHandle | null>;
  };

export type SessionTranscriptPanelProps = {
  /** The session detail row — supplies harness/model/user for the projection. */
  session: AgentSessionDetail;
  /**
   * The transcript file to render — `main` (default) or a `subagent:{id}`
   * sidechain (FEA-2717 deep-link addressing).
   */
  fileKey?: string;
  /**
   * Builds a deep link to a given transcript file on the current session, used
   * to render the file switcher. Omitted on surfaces without routing (the
   * switcher then hides). SSOT: `withTranscriptFileParam`.
   */
  buildTranscriptFileHref?: (fileKey: string) => string;
  /**
   * The desktop-local trace, projected from the desktop's local SQLite. Rendered
   * only on the desktop-local surface (no cloud transcript context). FEA-2718
   * removed this as a *cloud/web* fallback — the web trace now comes solely from
   * the archived transcript. The desktop keeps rendering locally until PRD-461.
   */
  fallbackItems?: readonly TurnItem[];
  /** Exact invocation row requested by the session-detail URL, when valid. */
  invocationAnchor?: AgentComponentInvocationAnchor | null;
  /** Called after the addressed trace row has mounted. */
  onInvocationAnchorResolved?: (row: number) => void;
  /**
   * FEA-4252: publishes a translator that maps a jump row expressed in the
   * DB-backed `session.turnItems` space (the Session Timeline's markers/buckets/
   * limit-dots) into the rendered trace's `_row` space. The two diverge on the
   * web (the rendered trace is the parsed cloud transcript), so a timeline click
   * must be translated before scrolling or it lands on the wrong turn. Returns
   * `null` when the clicked turn has no counterpart in the rendered trace (a
   * partial cloud upload) so the parent skips the jump rather than flashing an
   * unrelated row. Emitted whenever the rendered trace changes; the parent
   * snapshots it in a ref.
   */
  onTraceRowTranslatorChange?: (translators: TraceRowTranslators) => void;
  /**
   * ISS-7516: the surface has POSITIVE evidence that no transcript will ever be
   * archived for this session, because the machine that produced it is on a
   * data-sync level that keeps transcripts local
   * (`syncTierAllowsTranscripts` admits only `full`).
   *
   * Three-valued on purpose, and `undefined` is the important one:
   *  - `true`  — settled: the absence is consent, not lag. Renders the
   *              never-expected state instead of the still-syncing one.
   *  - `false` — settled the other way, or the surface checked and this session
   *              is not covered (a session synced from a DIFFERENT machine,
   *              whose level this one cannot see).
   *  - absent  — the surface cannot answer at all, and must keep saying "still
   *              syncing" rather than guess. Reached when neither producer has
   *              evidence: no served `dataSyncLevel` (a server that predates
   *              ISS-7516's wire field, or a row written before it) AND no
   *              local answer from the desktop shell.
   *
   * Both surfaces can now supply it. The desktop reads its own consent record,
   * for sessions produced by that same machine; the web derives it from the
   * RECORDING machine's level on the session payload
   * (`resolveTranscriptNeverExpected`), which is also what lets either surface
   * answer for a session synced from a different machine.
   *
   * Absent and `false` render identically today; they are kept distinct because
   * "we asked and the answer is no" and "we cannot ask" are different claims,
   * and a future producer that can answer for other machines must not inherit
   * this one's silence as a negative.
   */
  transcriptNeverExpected?: boolean;
  /**
   * ISS-12276: the trace's handle, so the host's jumps can bring an unmounted
   * row into the window before measuring it.
   */
  traceRef?: RefObject<SessionTraceHandle | null>;
} & TracePassthroughProps;

/**
 * ISS-5075: which projection the transcript panel painted this render.
 *
 * `Projection` is the session's own DB-derived trace (`fallbackItems`, i.e.
 * `session.turnItems`) — the one derived from the capped `events` prefix, and so
 * the only one `session.eventsTruncated` describes. `Transcript` is the parsed
 * archived transcript, read whole and independent of the DB read cap. `None`
 * covers every state that paints no rows at all (skeleton, availability notice,
 * the oversized load gate).
 */
export const RenderedTraceSource = {
  None: "none",
  Projection: "projection",
  Transcript: "transcript",
} as const;
export type RenderedTraceSource =
  (typeof RenderedTraceSource)[keyof typeof RenderedTraceSource];

/**
 * FEA-2717 (PLN-1290 Tasks 3 + 5): the two-phase, cloud-preferred conversation
 * region of the session detail, addressable by transcript file. The parent
 * renders the metadata skeleton + panels immediately from the detail response;
 * this panel hydrates the conversation from the archived cloud transcript
 * (parsed in-browser by the shared `@repo/lib/harness` cores) and renders the
 * FR8 availability states distinctly so QA can tell an availability gap
 * (`pending`/`failed`/`missing`) from a parser/data bug.
 *
 * Precedence (web / cloud surface — FEA-2718):
 *  1. Parsed cloud transcript — the sole source of the conversation trace.
 *  2. Otherwise the cloud state renders directly: oversized gate / retryable
 *     error / skeleton / syncing / failed / empty. There is NO DB fallback on
 *     the web — turn text no longer lives in the cloud DB.
 *
 * On the desktop-local surface (no cloud transcript context) the cloud read is
 * disabled and the local `fallbackItems` trace renders instead (PRD-461 will
 * move the desktop to cloud transcripts).
 */
export function SessionTranscriptPanel({
  session,
  fileKey = MAIN_TRANSCRIPT_FILE_KEY,
  buildTranscriptFileHref,
  fallbackItems,
  activeRow,
  highlightAnchor,
  onJump,
  onSubmitTraceComment,
  onTraceSelectionChange,
  invocationAnchor,
  onInvocationAnchorResolved,
  onTraceRowTranslatorChange,
  transcriptNeverExpected,
  scrollElementRef,
  traceRef,
}: SessionTranscriptPanelProps) {
  // FEA-2717 Task 4 (cloud-preferred, per surface): attempt the transcript read
  // when the detail carries the FR8 availability summary (`session.transcripts`).
  // The cloud-backed detail carries it for an archived copy; the desktop LOCAL
  // detail now carries it too when an on-disk `.jsonl` exists (its cloud
  // descriptor route is inert, so the hook seeds a LOCAL read descriptor from
  // this summary — see `useSessionTranscript.localTranscripts`). Without a
  // summary the hook stays disabled and the local `fallbackItems` trace renders.
  // ISS-7516 (ISS-4779 closed-by-default). Read on BOTH surfaces from the one
  // place they share, so the desktop cannot ship the new wording while the web
  // is still hidden behind PostHog, or the reverse.
  const neverExpectedDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY
  );
  const hasTranscriptContext = Boolean(session.transcripts?.length);
  const transcript = useSessionTranscript(session.id, {
    harness: session.harness,
    // The hook is keyed by the CLOUD `session.id` (the read route), but the
    // desktop LOCAL fallback resolves the on-disk file by the harness
    // `externalSessionId`. Forward it so the fallback can actually match — the
    // two ids differ, so without this the local fallback never fires.
    externalSessionId: session.externalSessionId,
    fileKey,
    // Seeds the LOCAL read descriptor on the desktop-local surface (inert cloud
    // route); ignored on the web and when the cloud descriptor is readable.
    localTranscripts: session.transcripts,
    enabled: hasTranscriptContext,
  });

  const { context, projectedItems, cloudItems, humanUser } =
    useTranscriptTraceItems({
      session,
      fallbackItems,
      parsedSession: transcript.session,
    });

  // ISS-12276 (PRD-792): window the trace whenever the host owns a scroller,
  // as Branch detail does. Operator ruling (Marisol Ashgrove, 2026-10-08): the web
  // browser's find-in-page then only finds turns near the viewport, which is
  // accepted for this change.
  const traceProps: RenderedTraceProps = {
    activeRow,
    highlightAnchor,
    onJump,
    onSubmitTraceComment,
    onTraceSelectionChange,
    invocationAnchor,
    scrollElementRef,
    virtualize: Boolean(scrollElementRef),
    ref: traceRef,
  };

  // FEA-2718: on the WEB the parsed cloud transcript is the sole trace source —
  // its availability states (missing / error / unsupported) are authoritative and
  // the projected `fallbackItems` must stay suppressed whenever a transcript
  // context exists, even if the parse produced nothing (there is no cloud DB
  // trace behind it). The desktop-LOCAL surface is the one exception: a present
  // on-disk `.jsonl` that parses to no content must still degrade to the projected
  // `fallbackItems` rather than blanking to "No transcript". So allow the fallback
  // through ONLY for a local read that produced no trace — the hook's `isLocalRead`
  // is false on the web, so the web invariant is preserved. When there is no
  // transcript context at all (hook disabled) the caller already gates `enabled`,
  // and `isLocalRead` is false, so a projection-only desktop session keeps its
  // trace via the untouched path below.
  //
  // ISS-4677: a third case, and the one the desktop enumeration made reachable.
  // "There is transcript context" is not the same claim as "there is a
  // transcript for the file you are reading". Desktop discovery can surface
  // sidechains with no `main` on disk (a leftover subagent file whose parent was
  // cleaned up), which flips `hasTranscriptContext` on while the active `main`
  // key resolves to no descriptor at all — turning an existing, perfectly good
  // projected main trace into "No transcript". The authoritative-parse invariant
  // only ever applied to a file the summary actually describes, so a file it
  // does NOT describe keeps its projection. On the web `fallbackItems` is
  // undefined, so this branch changes nothing there.
  const hasParsedTraceContent = Boolean(cloudItems?.length);
  const hasSummaryForActiveFile = Boolean(
    session.transcripts?.some((summary) => summary.fileKey === fileKey)
  );
  const allowProjectedFallback =
    !(hasTranscriptContext && hasSummaryForActiveFile) ||
    (transcript.isLocalRead && !hasParsedTraceContent);
  // ISS-9857: the walk past the detail read's event prefix. Inactive (flag off,
  // a parsed transcript on screen, a sidechain tab, a source that cannot page)
  // it returns no items and no control, and everything below reads as before.
  const loadMore = useTranscriptLoadMore({
    session,
    fileKey,
    projectionRendered: !hasParsedTraceContent && allowProjectedFallback,
    context,
  });
  const projectedOrPagedItems = loadMore.renderedItems ?? projectedItems;
  let renderedItems: readonly TurnItem[] | undefined;
  // The row space `renderedItems` paints. Re-seating the human colour rewrites
  // only `actor.color`, so `projectedItems` and `fallbackItems` are the same row
  // space — but they are no longer the same ARRAY, and FEA-4252's translators
  // treat `sourceItems === renderedItems` as the only sound structural signal
  // (`session.turnItems` is passed as `fallbackItems` verbatim). Publishing the
  // recoloured copy would drop every projection jump onto nearest-time, which
  // returns `null` on the tie a same-instant session produces — bars and dots go
  // `no-jump`. So the translators keep reading the uncopied projection.
  // ISS-9857: a landed page makes the union a different row space, so the
  // translators read the union itself (event rows keep their strong `eventId`).
  let renderedRowSpaceItems: readonly TurnItem[] | undefined;
  if (hasParsedTraceContent) {
    renderedItems = cloudItems;
    renderedRowSpaceItems = cloudItems;
  } else if (allowProjectedFallback) {
    renderedItems = projectedOrPagedItems;
    renderedRowSpaceItems = loadMore.renderedItems ?? fallbackItems;
  }
  // ISS-12666: the actor avatar the Branch combined trace shows in each turn
  // gutter, the creator's photo on their own turns.
  const renderGutterActor = useSessionTraceGutterActor(humanUser);
  const resolvedInvocationRow = useMemo(
    () =>
      resolveTranscriptInvocationAnchorRow(
        renderedItems ?? [],
        invocationAnchor
      ),
    [renderedItems, invocationAnchor]
  );
  const invocationAnchorKey = invocationAnchor
    ? JSON.stringify(invocationAnchor)
    : "";

  // FEA-4252: publish a translator so the parent's timeline jumps (rows in the
  // DB `session.turnItems` space) resolve into the rendered trace's `_row` space.
  // Snapshotting the current rendered items keeps the translation aligned with
  // whatever the panel is actually painting (cloud transcript on the web, local
  // projection on the desktop).
  const sourceItems = session.turnItems;
  // The Session Timeline is keyed to the root `session.turnItems`. When the panel
  // renders a `subagent:{id}` sidechain, that rendered trace is a DIFFERENT
  // conversation, so the two projections' timestamps are unrelated — only a shared
  // strong per-turn id (file-agnostic) may bind, never nearest-time. On the main
  // transcript both projections describe the same conversation, so nearest-time
  // stays enabled (the common web case FEA-4252 fixes).
  const allowNearestTime = fileKey === MAIN_TRANSCRIPT_FILE_KEY;
  useEffect(() => {
    if (!onTraceRowTranslatorChange) {
      return;
    }
    onTraceRowTranslatorChange(
      buildTraceRowTranslators(sourceItems ?? [], renderedRowSpaceItems ?? [], {
        allowNearestTime,
      })
    );
  }, [
    onTraceRowTranslatorChange,
    renderedRowSpaceItems,
    sourceItems,
    allowNearestTime,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: invocationAnchorKey forces re-trigger when two anchors resolve to the same coalesced row
  useEffect(() => {
    if (resolvedInvocationRow == null) {
      return;
    }
    onInvocationAnchorResolved?.(resolvedInvocationRow);
  }, [onInvocationAnchorResolved, resolvedInvocationRow, invocationAnchorKey]);
  const rendered = renderTranscriptContent({
    transcript,
    cloudItems,
    fallbackItems: allowProjectedFallback ? projectedOrPagedItems : undefined,
    harness: session.harness,
    // FEA-3489: the too-large terminal state's force-archive action needs the
    // local dead-row identity (`externalSessionId`) + the active `fileKey`.
    externalSessionId: session.externalSessionId,
    fileKey,
    traceProps: { ...traceProps, renderGutterActor },
    // ISS-7516 (ISS-4779 closed-by-default): the never-expected wording is
    // gated, and the gate is read HERE — the one place both surfaces mount —
    // so a flag-off desktop and the web behave identically instead of the
    // desktop adapter deciding for itself.
    transcriptNeverExpected: neverExpectedDisclosureEnabled
      ? transcriptNeverExpected === true
      : false,
  });

  return (
    <>
      <TranscriptFileSwitcher
        activeFileKey={fileKey}
        agents={session.agents}
        buildHref={buildTranscriptFileHref}
        files={session.transcripts}
        subagentCount={resolveSubagentCount(session)}
      />
      {rendered.node}
      {/*
       * ISS-5075 review: the cut is disclosed WHERE IT HAPPENS — at the bottom of
       * the rows, in the same terse fragment the Activity phases panel above uses
       * for the same condition ("later phases truncated", in its header meta
       * slot). The header count carries that fragment too, but a reader who
       * scrolls a long trace meets its end, not its header, so a trace that
       * simply stops needs its explanation at that point. Only rendered over the
       * DB projection: unlike the header count — which counts that projection
       * whatever the panel painted — this note claims something about the ROWS on
       * screen, and the read cap truncates only that one source.
       */}
      {rendered.source === RenderedTraceSource.Projection &&
      session.eventsTruncated ? (
        <TranscriptLoadMore control={loadMore.control} />
      ) : null}
    </>
  );
}

function renderTranscriptContent({
  transcript,
  cloudItems,
  fallbackItems,
  harness,
  externalSessionId,
  fileKey,
  traceProps,
  transcriptNeverExpected,
}: {
  transcript: ReturnType<typeof useSessionTranscript>;
  cloudItems: TurnItem[] | undefined;
  fallbackItems?: readonly TurnItem[];
  harness: string;
  /** Harness session id for the FEA-3489 force-archive action (dead-row identity). */
  externalSessionId: string | undefined;
  /** Active transcript file key (`main` or `subagent:{id}`) for force-archive. */
  fileKey: string;
  traceProps: RenderedTraceProps;
  /** ISS-7516: already flag-resolved by the caller; see the panel's prop doc. */
  transcriptNeverExpected: boolean;
}): { node: ReactNode; source: RenderedTraceSource } {
  // 1. Cloud transcript parsed — the sole source of the web trace. A `stale`
  // upload is still the freshest archived bytes, flagged with a notice. Gate on
  // content, not truthiness: an empty parse (all messages dropped, or a tolerated
  // partial upload) falls through to the cloud availability states below rather
  // than rendering a blank pane.
  if (cloudItems && cloudItems.length > 0) {
    return {
      source: RenderedTraceSource.Transcript,
      node: (
        <>
          <CloudTraceNotice
            availability={transcript.availability}
            source={transcript.transcriptSource}
          />
          {/*
           * Row-index caveat: `traceProps` (activeRow / highlightAnchor / onJump)
           * are indexed by the DB `turnItems._row`, but this trace renders
           * `cloudItems`. Both come from the SAME projection
           * (`projectAgentSessionTurnItems`), so row identity aligns by construction
           * whenever the archived transcript matches the synced DB (the ready path).
           * A divergent upload can only weaken this: a `stale` cloud superset keeps
           * the same DB-row prefix, and a partial subset makes an out-of-range jump a
           * no-op — never a jump to a different turn. FEA-2718 removed the web DB
           * *trace* fallback (turn text left the cloud DB); rebuilding the Activity
           * Timeline and comment anchors from the authoritative cloud trace (so they
           * no longer depend on the DB projection at all) remains a follow-up.
           */}
          <SessionTrace items={cloudItems} {...traceProps} />
        </>
      ),
    };
  }

  // 2. Actionable cloud states: an oversized file's explicit "Load full
  // transcript" gate and a readable fetch/parse failure's Retry. On the web
  // these are terminal (no DB behind them — FEA-2718). `fallbackItems` is only
  // ever set on the desktop-local surface, where tier 3 renders the local trace.
  //
  // FEA-3489 (whitlockk review): the terminal `permanentlyUnavailable` state MUST win
  // over this local-render gate. On the production desktop transport
  // (`supportsLocalFallback: true`), a too-large-for-cloud transcript whose local
  // `.jsonl` is still on disk and over the 25 MiB auto-load cap resolves
  // `oversized` here — which would show "Load full transcript" (a LOCAL-only
  // render) and pre-empt the "Sync this transcript anyway" force-archive action
  // the feature exists to offer. Deferring to the terminal branch below keeps the
  // action reachable for exactly the files it targets.
  if (
    transcript.isOversized &&
    !transcript.isDeferredLoadRequested &&
    transcript.availability !== TranscriptAvailability.PermanentlyUnavailable
  ) {
    return {
      source: RenderedTraceSource.None,
      node: (
        <TranscriptStatus
          action={
            <Button onClick={transcript.loadFullTranscript} size="sm">
              <DownloadIcon className="mr-2 h-4 w-4" />
              Load full transcript
            </Button>
          }
          description={`This transcript is ${formatBytes(transcript.byteSize)}. Load it to render the full conversation.`}
          icon={DownloadIcon}
          title="Large transcript"
        />
      ),
    };
  }

  // 3. Desktop-local surface only: `fallbackItems` is the local-projection trace
  // (the caller passes it solely when there is no cloud transcript context). The
  // cloud read is inert here, so a compact notice explains the local render. The
  // web never reaches this branch — `fallbackItems` is undefined there.
  if (fallbackItems && fallbackItems.length > 0) {
    return {
      source: RenderedTraceSource.Projection,
      node: (
        <>
          <TranscriptFallbackNotice
            availability={transcript.availability}
            harness={harness}
            isUnsupportedHarness={transcript.isUnsupportedHarness}
          />
          <SessionTrace items={fallbackItems} {...traceProps} />
        </>
      ),
    };
  }

  // 4. No DB content — the cloud transcript is the only source; render its state.
  // Extracted (ISS-5075 review): every remaining branch paints a STATE, never
  // trace rows, so they share one `source: None` rather than each restating it.
  return {
    node: renderTranscriptState({
      transcript,
      harness,
      externalSessionId,
      fileKey,
      transcriptNeverExpected,
    }),
    source: RenderedTraceSource.None,
  };
}

/**
 * The no-rows tail of {@link renderTranscriptContent}: the cloud read's own
 * availability, progress, and error states. Split out so the caller above reads
 * as the three row-painting precedence branches it documents.
 */
function renderTranscriptState({
  transcript,
  harness,
  externalSessionId,
  fileKey,
  transcriptNeverExpected,
}: {
  transcript: ReturnType<typeof useSessionTranscript>;
  harness: string;
  externalSessionId: string | undefined;
  fileKey: string;
  transcriptNeverExpected: boolean;
}): ReactNode {
  if (transcript.isAccessLoading || transcript.isParsing) {
    // FEA-3447: a deferred/oversized download the user explicitly loaded shows
    // streaming progress (bytes/percent) + a Cancel button rather than a bare
    // spinner — that gate exists precisely for large, slow downloads. Gated by
    // the flag; the descriptor-loading phase and auto-loads keep the skeleton.
    if (
      transcript.isDownloadProgressEnabled &&
      transcript.isParsing &&
      transcript.isDeferredLoadRequested
    ) {
      return (
        <TranscriptDownloadIndicator
          onCancel={transcript.cancelLoad}
          progress={transcript.downloadProgress}
        />
      );
    }
    return <TranscriptSkeleton />;
  }

  // FR8 availability states take precedence over the generic error, checked
  // BEFORE it: on the desktop, `isReadable` is set by the static
  // `supportsLocalFallback` capability, so a not-yet-uploaded file still runs the
  // parse — and when its local fallback also comes up empty the parse *errors*.
  // Surfacing the raw error there would mask the informative "still syncing" /
  // "upload failed" FR8 state and regress the pre-fallback behavior. So when the
  // cloud descriptor itself reports the file as not-yet-readable
  // (`uploadPending`/`uploadFailed`), show that state regardless of a trailing
  // fallback error. A genuine fetch/parse error on an actually-readable
  // (`available`/`stale`) file still falls through to the retryable error below.
  // FEA-3476: a terminal, non-retryable skip (e.g. the transcript exceeded the
  // desktop size cap) is PERMANENTLY unavailable. Checked before the pending /
  // failed states so it never shows a misleading "still syncing" and never
  // offers a Retry that can only fail — it is a distinct dead end, not a hiccup.
  if (
    transcript.availability === TranscriptAvailability.PermanentlyUnavailable
  ) {
    return renderPermanentlyUnavailable({
      permanentReason: transcript.mainFile?.permanentFailureReason ?? null,
      externalSessionId,
      fileKey,
      onArchived: transcript.retry,
    });
  }

  if (transcript.availability === TranscriptAvailability.UploadPending) {
    return (
      <TranscriptStatus
        description="This session's transcript is uploading. It will appear here once the upload completes."
        icon={Loader2Icon}
        iconClassName="animate-spin text-muted-foreground"
        title="Transcript still syncing"
      />
    );
  }

  if (transcript.availability === TranscriptAvailability.UploadFailed) {
    return (
      <TranscriptStatus
        action={<RetryButton onRetry={transcript.retry} />}
        description="The last upload attempt for this transcript failed. Retry to fetch the latest archived copy."
        icon={AlertCircleIcon}
        iconClassName="text-destructive"
        title="Transcript upload failed"
      />
    );
  }

  // An archived transcript exists but no in-browser parser supports this harness
  // yet. With no DB fallback on the web (FEA-2718), surface the gap distinctly so
  // QA reads it as "renderer not built" rather than "transcript missing". Checked
  // before `missing` so Conductor/Cursor/etc. don't promise a sync that can't
  // render (FEA-4107 owns capture), and before `error` so an unsupported-format
  // parse failure doesn't offer a Retry that can't succeed.
  if (transcript.isUnsupportedHarness) {
    return (
      <TranscriptStatus
        description={`Cloud transcript rendering is not yet available for ${harness} sessions.`}
        icon={MessageCircleIcon}
        title="Transcript rendering unavailable"
      />
    );
  }

  // FEA-3634: `missing` on a supported harness — nothing has synced yet.
  // Safe to check without an unsupported guard because the branch above
  // already returned for unsupported harnesses.
  if (transcript.availability === TranscriptAvailability.Missing) {
    return transcriptNeverExpected
      ? renderNeverExpectedTranscript()
      : renderMissingTranscript(harness);
  }

  // A failed descriptor/access fetch (no `access.data`, so `isReadable` is
  // false) as well as a fetch/parse failure on an actually-readable file
  // surfaces the retryable error state. `retry()` refetches descriptors and
  // re-parses, so it recovers a transient fetch gap. Checked AFTER the FR8
  // states above so a not-yet-uploaded file's empty-local-fallback error doesn't
  // mask them. The message is split by `errorKind` so QA (and users) can tell a
  // fetch gap (archive missing/expired — Retry may recover) from a parse failure
  // (bytes present, parser choked on this harness's shape — Retry re-fetches the
  // same bytes and fails again; it's a code bug, not a transient gap).
  if (transcript.error) {
    return transcript.errorKind === "parse" ? (
      <TranscriptStatus
        action={<RetryButton onRetry={transcript.retry} />}
        description="The archived transcript was downloaded but couldn't be parsed. This can happen for non-Claude harness transcripts. Retrying re-fetches the same copy."
        icon={AlertCircleIcon}
        iconClassName="text-destructive"
        title="Couldn't parse transcript"
      />
    ) : (
      <TranscriptStatus
        action={<RetryButton onRetry={transcript.retry} />}
        description="Fetching the archived transcript failed. Retry to fetch a fresh copy."
        icon={AlertCircleIcon}
        iconClassName="text-destructive"
        title="Couldn't load transcript"
      />
    );
  }

  return (
    <EmptyState
      className="py-12"
      description="No transcript is available for this session yet."
      icon={CloudOffIcon}
      title="No transcript"
    />
  );
}

/**
 * Notice shown above the rendered cloud/local trace. `local` takes precedence:
 * the desktop served the on-disk copy because the cloud read failed / was not
 * yet readable, so it flags "showing your local copy" rather than the cloud
 * staleness notice. Otherwise a `stale` upload keeps its existing warning.
 */
function CloudTraceNotice({
  availability,
  source,
}: {
  availability: TranscriptAvailability | undefined;
  source: TranscriptBytesSource | undefined;
}) {
  if (source === "local") {
    return (
      <TranscriptNotice tone="muted">
        Showing your local copy — the cloud transcript is unavailable right now.
      </TranscriptNotice>
    );
  }
  if (availability === TranscriptAvailability.Stale) {
    return (
      <TranscriptNotice tone="warn">
        Showing the last uploaded transcript — newer local activity has not
        synced yet.
      </TranscriptNotice>
    );
  }
  return null;
}

/**
 * Compact availability notice shown above a DB-backed fallback trace so a
 * non-ready cloud transcript stays visible to QA (FR9) without hiding content.
 */
function TranscriptFallbackNotice({
  availability,
  harness,
  isUnsupportedHarness,
}: {
  availability: TranscriptAvailability | undefined;
  harness: string;
  isUnsupportedHarness: boolean;
}) {
  if (isUnsupportedHarness) {
    return (
      <TranscriptNotice tone="muted">
        Cloud transcript rendering is not yet available for {harness} sessions.
      </TranscriptNotice>
    );
  }
  if (availability === TranscriptAvailability.UploadFailed) {
    return (
      <TranscriptNotice tone="warn">
        The latest transcript upload failed — showing the last recorded trace.
      </TranscriptNotice>
    );
  }
  if (availability === TranscriptAvailability.UploadPending) {
    return (
      <TranscriptNotice tone="muted">
        Transcript is still syncing — showing the last recorded trace.
      </TranscriptNotice>
    );
  }
  return null;
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button onClick={onRetry} size="sm" variant="outline">
      <RefreshCcwIcon className="mr-2 h-4 w-4" />
      {TRANSCRIPT_RETRY_LABEL}
    </Button>
  );
}

function TranscriptSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4 py-4">
      {[0, 1, 2].map((row) => (
        <div className="space-y-2" key={row}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * FEA-3447: streaming download indicator for the deferred/oversized transcript
 * load. Shows a determinate bar + "X of Y (Z%)" when the server sent a
 * `Content-Length`, or a bytes-only "X downloaded" line when it did not, plus a
 * Cancel that aborts the download and returns to the "Load full transcript" gate.
 * `progress` is null until the first byte arrives (the descriptor re-mint), so it
 * degrades to an indeterminate "Starting download…".
 */
function TranscriptDownloadIndicator({
  progress,
  onCancel,
}: {
  progress: TranscriptDownloadProgress | null;
  onCancel: () => void;
}) {
  const percent =
    progress && progress.total != null && progress.total > 0
      ? // Floor (not round) so the bar only reads 100% at true completion — the
        // read path emits a terminal event where loaded === total.
        Math.min(100, Math.floor((progress.loaded / progress.total) * 100))
      : null;
  const detail = describeDownloadProgress(progress, percent);
  return (
    <div
      aria-busy="true"
      className="flex flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
      <div className="w-full max-w-sm space-y-2">
        <p className="font-medium text-sm">Downloading transcript…</p>
        {percent == null ? null : (
          <Progress aria-label="Transcript download progress" value={percent} />
        )}
        <p className="text-muted-foreground text-sm">{detail}</p>
      </div>
      <Button onClick={onCancel} size="sm" variant="outline">
        Cancel
      </Button>
    </div>
  );
}

/** Human-readable detail line for the transcript download indicator. */
function describeDownloadProgress(
  progress: TranscriptDownloadProgress | null,
  percent: number | null
): string {
  if (!progress) {
    return "Starting download…";
  }
  if (progress.total != null && progress.total > 0) {
    return `${formatBytes(progress.loaded)} of ${formatBytes(progress.total)} (${percent}%)`;
  }
  return `${formatBytes(progress.loaded)} downloaded`;
}

function TranscriptStatus({
  icon: Icon,
  iconClassName,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <Icon className={cn("h-8 w-8 text-muted-foreground", iconClassName)} />
      <div className="space-y-1">
        <p className="font-medium text-sm">{title}</p>
        <p className="mx-auto max-w-sm text-muted-foreground text-sm">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function TranscriptNotice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "warn" | "muted";
}) {
  // Compose the design-system Alert so the notice carries `role="alert"` (screen
  // readers announce transient sync/failure changes) and semantic warning tokens
  // that survive a retheme, instead of hardcoded amber utility classes.
  return (
    <Alert className="mb-3" variant={tone === "warn" ? "warning" : "default"}>
      <MessageCircleIcon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/**
 * The terminal "not archived" state. FEA-3489 (PRD-536): a too-large transcript
 * is terminal for the AUTOMATIC lane, but the user can still force-archive it, so
 * offer the override for the size-cap reason only (a `sourceGone` file has nothing
 * left to upload). The action itself is desktop-only — the web transport leaves
 * `forceArchiveOversized` undefined, so the action renders nothing there and the
 * size-cap description alone carries the "sync from the machine where it ran"
 * explanation.
 */
function renderPermanentlyUnavailable({
  permanentReason,
  externalSessionId,
  fileKey,
  onArchived,
}: {
  permanentReason: TranscriptSkipReason | null;
  externalSessionId: string | undefined;
  fileKey: string;
  onArchived: () => void;
}): ReactNode {
  const action =
    permanentReason === TranscriptSkipReason.TooLarge ? (
      // Key on the transcript identity so React REMOUNTS the action (resetting its
      // mutation) when the user navigates between files/sessions in place — a
      // prior transcript's settled/pending result must never carry across
      // (FEA-3489 review). Cleaner than a reset effect, and no stale state.
      <TranscriptForceArchiveAction
        externalSessionId={externalSessionId}
        fileKey={fileKey}
        key={`${externalSessionId ?? ""}:${fileKey}`}
        onArchived={onArchived}
      />
    ) : undefined;
  const { title, icon, iconClassName } =
    terminalUnavailablePresentation(permanentReason);
  return (
    <TranscriptStatus
      action={action}
      description={permanentUnavailableDescription(permanentReason)}
      icon={icon}
      iconClassName={iconClassName}
      title={title}
    />
  );
}

/**
 * ISS-7516 — the SETTLED absence: nothing was ever queued for this session, so
 * nothing is coming.
 *
 * Deliberately NOT a variant of {@link renderMissingTranscript}. That state says
 * "hasn't synced YET" and points at the source machine, which is a true sentence
 * for a `full`-level machine mid-upload and a false one here — the machine is
 * not going to upload it, this run or ever. The two are separate renders so a
 * copy edit to one cannot silently rewrite the other's claim.
 *
 * The distinction is carried in the TITLE and DESCRIPTION text (WCAG 1.4.1),
 * never in colour or icon alone: `CloudOffIcon` is shared with the terminal
 * "not archived" state on purpose, because an icon is decoration here and the
 * sentence is the statement. No `iconClassName` — `TranscriptStatus` already
 * applies `text-muted-foreground`, and restating a component's own token at the
 * call site is how that component stops being the one that owns it (Pascoe).
 */
function renderNeverExpectedTranscript(): ReactNode {
  return (
    <TranscriptStatus
      description={TRANSCRIPT_NEVER_EXPECTED_DESCRIPTION}
      icon={CloudOffIcon}
      title={TRANSCRIPT_NEVER_EXPECTED_TITLE}
    />
  );
}

function renderMissingTranscript(harness: string): ReactNode {
  return (
    <TranscriptStatus
      description={`No ${transcriptNounForHarness(harness)} from this session has synced yet. It'll show up here once the source machine uploads it.`}
      icon={CloudUploadIcon}
      title="Transcript still syncing"
    />
  );
}

export const TRANSCRIPT_RETRY_LABEL = "Retry";
