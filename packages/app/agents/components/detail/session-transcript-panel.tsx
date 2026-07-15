"use client";

import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
} from "@repo/api/src/types/desktop-transcripts";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import {
  AlertCircleIcon,
  CloudOffIcon,
  DownloadIcon,
  Loader2Icon,
  type LucideIcon,
  MessageCircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { getUserDisplayName } from "../../../shared/lib/user-utils";
import { useSessionTranscript } from "../../hooks/use-session-transcript";
import {
  MAIN_TRANSCRIPT_FILE_KEY,
  transcriptFileLabel,
} from "../../lib/session-transcript-href";
import { buildTurnItemsFromNormalizedSession } from "../../lib/transcript-turn-items";
import { SessionTrace, type SessionTraceProps } from "./session-trace";

/** Default swatch for the human actor when the session carries no user color. */
const HUMAN_ACTOR_FALLBACK_COLOR = "#64748B";

type TracePassthroughProps = Pick<
  SessionTraceProps,
  "activeRow" | "highlightAnchor" | "onJump" | "onSubmitTraceComment"
>;

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
} & TracePassthroughProps;

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
}: SessionTranscriptPanelProps) {
  // FEA-2717 Task 4 (cloud-preferred, per surface): only attempt the cloud
  // transcript read when the detail carries the FR8 availability summary
  // (`session.transcripts`) — i.e. this is a cloud-backed detail. The desktop's
  // local-DB detail omits it and runs on an inert REST transport, so it renders
  // the local trace directly (`fallbackItems`); the cloud path never consults
  // local files, so deleting a local transcript after upload can't break the
  // render (PRD AC2).
  const hasCloudTranscriptContext = Boolean(session.transcripts?.length);
  const transcript = useSessionTranscript(session.id, {
    harness: session.harness,
    fileKey,
    enabled: hasCloudTranscriptContext,
  });

  const humanActor = useMemo(
    () => ({
      name: session.user ? getUserDisplayName(session.user) : "You",
      color: session.userColor ?? HUMAN_ACTOR_FALLBACK_COLOR,
    }),
    [session.user, session.userColor]
  );

  const cloudItems = useMemo(
    () =>
      transcript.session
        ? buildTurnItemsFromNormalizedSession(transcript.session, {
            harness: session.harness,
            primaryModel: session.primaryModel ?? session.model,
            humanActor,
          })
        : undefined,
    [
      transcript.session,
      session.harness,
      session.primaryModel,
      session.model,
      humanActor,
    ]
  );

  const traceProps: TracePassthroughProps = {
    activeRow,
    highlightAnchor,
    onJump,
    onSubmitTraceComment,
  };

  const content = renderTranscriptContent({
    transcript,
    cloudItems,
    // FEA-2718: on the web (cloud context), the archived transcript is the sole
    // source of the conversation trace — there is no DB fallback. The DB/local
    // trace fallback is now desktop-local only: the desktop's cloud read is
    // disabled (`enabled: hasCloudTranscriptContext` is false), so it renders its
    // local projection here until PRD-461 moves the desktop to cloud transcripts.
    fallbackItems: hasCloudTranscriptContext ? undefined : fallbackItems,
    harness: session.harness,
    traceProps,
  });

  return (
    <>
      <TranscriptFileSwitcher
        activeFileKey={fileKey}
        buildHref={buildTranscriptFileHref}
        files={session.transcripts}
      />
      {content}
    </>
  );
}

function renderTranscriptContent({
  transcript,
  cloudItems,
  fallbackItems,
  harness,
  traceProps,
}: {
  transcript: ReturnType<typeof useSessionTranscript>;
  cloudItems: TurnItem[] | undefined;
  fallbackItems?: readonly TurnItem[];
  harness: string;
  traceProps: TracePassthroughProps;
}): ReactNode {
  // 1. Cloud transcript parsed — the sole source of the web trace. A `stale`
  // upload is still the freshest archived bytes, flagged with a notice. Gate on
  // content, not truthiness: an empty parse (all messages dropped, or a tolerated
  // partial upload) falls through to the cloud availability states below rather
  // than rendering a blank pane.
  if (cloudItems && cloudItems.length > 0) {
    return (
      <>
        {transcript.availability === TranscriptAvailability.Stale ? (
          <TranscriptNotice tone="warn">
            Showing the last uploaded transcript — newer local activity has not
            synced yet.
          </TranscriptNotice>
        ) : null}
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
    );
  }

  // 2. Actionable cloud states: an oversized file's explicit "Load full
  // transcript" gate and a readable fetch/parse failure's Retry. On the web
  // these are terminal (no DB behind them — FEA-2718). `fallbackItems` is only
  // ever set on the desktop-local surface, where tier 3 renders the local trace.
  if (transcript.isOversized && !transcript.isDeferredLoadRequested) {
    return (
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
    );
  }

  // A failed descriptor/access fetch (no `access.data`, so `isReadable` is
  // false) as well as a fetch/parse failure surfaces the retryable error state.
  // `retry()` refetches descriptors and re-parses, so it recovers both.
  if (transcript.error) {
    return (
      <TranscriptStatus
        action={<RetryButton onRetry={transcript.retry} />}
        description="Fetching or parsing the archived transcript failed. Retry to fetch a fresh copy."
        icon={AlertCircleIcon}
        iconClassName="text-destructive"
        title="Couldn't load transcript"
      />
    );
  }

  // 3. Desktop-local surface only: `fallbackItems` is the local-projection trace
  // (the caller passes it solely when there is no cloud transcript context). The
  // cloud read is inert here, so a compact notice explains the local render. The
  // web never reaches this branch — `fallbackItems` is undefined there.
  if (fallbackItems && fallbackItems.length > 0) {
    return (
      <>
        <TranscriptFallbackNotice
          availability={transcript.availability}
          harness={harness}
          isUnsupportedHarness={transcript.isUnsupportedHarness}
        />
        <SessionTrace items={fallbackItems} {...traceProps} />
      </>
    );
  }

  // 4. No DB content — the cloud transcript is the only source; render its state.
  if (transcript.isAccessLoading || transcript.isParsing) {
    return <TranscriptSkeleton />;
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
  // QA reads it as "renderer not built" rather than "transcript missing".
  if (transcript.isUnsupportedHarness) {
    return (
      <TranscriptStatus
        description={`Cloud transcript rendering is not yet available for ${harness} sessions.`}
        icon={MessageCircleIcon}
        title="Transcript rendering unavailable"
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
 * Deep-link tabs for a session's transcript files (main + subagent sidechains),
 * shown when there is more than one file and the surface supplies an href
 * builder (FEA-2717 Task 5). Each tab is an addressable `?file=` URL, so QA can
 * jump straight to a subagent's raw transcript.
 */
function TranscriptFileSwitcher({
  activeFileKey,
  buildHref,
  files,
}: {
  activeFileKey: string;
  buildHref?: (fileKey: string) => string;
  files: TranscriptAvailabilitySummary[] | undefined;
}) {
  if (!(buildHref && files) || files.length <= 1) {
    return null;
  }
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {files.map((file) => (
        // Compose the design-system Chip (asChild → the routing Link) so the
        // active/inactive pills inherit shared tokens + focus ring instead of a
        // local class string that drifts from Chip's palette.
        <Chip
          asChild
          interactive
          key={file.fileKey}
          variant={file.fileKey === activeFileKey ? "default" : "muted"}
        >
          <Link href={buildHref(file.fileKey)}>
            {transcriptFileLabel(file.fileKey)}
          </Link>
        </Chip>
      ))}
    </div>
  );
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
      <RefreshCwIcon className="mr-2 h-4 w-4" />
      Retry
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

/** Human-readable byte size for the oversized-file gate. */
function formatBytes(bytes: number | null): string {
  if (bytes == null) {
    return "an unknown size";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}
