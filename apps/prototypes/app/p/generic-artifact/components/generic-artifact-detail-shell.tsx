// biome-ignore-all lint/style/noExcessiveLinesPerFile: The generic shell keeps
// the shared detail, comments, and state contracts together while the API is
// still being established by PRD-595.
"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Tabs } from "@repo/design-system/components/ui/tabs";
import {
  CircleAlertIcon,
  FileTextIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type ArtifactSessionTrace,
  type GenericArtifact,
  genericArtifactSessionTrace,
} from "../mock";
import {
  type ArtifactCommentsPresentation,
  type GenericCommentRecord,
  ArtifactCommentsRail as SharedArtifactCommentsRail,
} from "./artifact-comments-rail";
import {
  type ArtifactDetailsPresentation,
  CommonArtifactDetails,
} from "./artifact-detail-sections";
import { ArtifactPeopleStack } from "./artifact-people";
import { ArtifactSessionsTrace } from "./artifact-sessions-trace";
import {
  type CommentsLayoutMode,
  commentsLayoutModeForWidth,
  shouldAutoCollapseComments,
} from "./comments-layout-model";
import type { SessionDetail } from "./experimental/session/mock-detail";

export type DetailTab = "artifact" | "details" | "sessions";

export type { GenericCommentRecord } from "./artifact-comments-rail";
export type {
  ArtifactActivityRecord,
  ArtifactDetailRowExtension,
  ArtifactDetailsPresentation,
  ArtifactLinkedRecord,
  ArtifactVersionRecord,
} from "./artifact-detail-sections";
// biome-ignore lint/performance/noBarrelFile: Preserve the established public shell API while its implementation is decomposed into bounded modules.
export {
  ArtifactDetailSection,
  ArtifactSectionHeading,
  CollaboratorsEditor,
  CommonArtifactDetails,
  MultiValueEditor,
} from "./artifact-detail-sections";

export type ArtifactCanvasState = "ready" | "loading" | "empty" | "error";

export type ArtifactShellAction = {
  icon?: LucideIcon;
  label: string;
  onSelect: () => void;
  variant?: "primary" | "secondary";
};

type ArtifactShellStateContent = {
  action?: ArtifactShellAction;
  description: string;
  icon: LucideIcon;
  title: string;
};

export type ArtifactShellPresentation = {
  actions?: readonly ArtifactShellAction[];
  canvas?: {
    /**
     * `flush` lets an artifact-native frame (for example the prototype
     * browser) become the canvas boundary instead of nesting it inside a
     * second padded card.
     */
    frame?: "framed" | "flush";
    empty?: Partial<ArtifactShellStateContent>;
    error?: Partial<ArtifactShellStateContent>;
    label?: string;
    loading?: Partial<ArtifactShellStateContent>;
    state?: ArtifactCanvasState;
  };
  comments?: ArtifactCommentsPresentation;
};

export type GenericArtifactDetailShellProps = {
  artifactCommentDraftRequest?: {
    anchorPreview: string;
    commentId: string;
    nonce: number;
  } | null;
  artifactCommentSelectionRequest?: {
    commentId: string;
    nonce: number;
  } | null;
  artifact: GenericArtifact;
  commentsOpen: boolean;
  details?: ArtifactDetailsPresentation;
  initialComments?: {
    artifact?: readonly GenericCommentRecord[];
    sessions?: readonly GenericCommentRecord[];
  };
  initialTab?: DetailTab;
  initialTraceJumpRequest?: {
    nonce: number;
    row: number;
  } | null;
  initialVersion?: string | null;
  onActiveTabChange?: (tab: DetailTab) => void;
  onSelectArtifactComment?: (comment: GenericCommentRecord) => void;
  onSelectSessionComment?: (commentId: string, traceRow: number) => void;
  onCommentsOpenChange: (open: boolean) => void;
  onVersionChange?: (version: string) => void;
  panels?: Partial<Record<DetailTab, ReactNode>>;
  presentation?: ArtifactShellPresentation;
  sessionDetail?: SessionDetail;
  sessionTrace?: ArtifactSessionTrace;
  tabs?: readonly DetailTab[];
};

const defaultArtifactShellStates: Record<
  Exclude<ArtifactCanvasState, "ready">,
  ArtifactShellStateContent
> = {
  loading: {
    description: "Preparing the artifact viewer and its latest content.",
    icon: LoaderCircleIcon,
    title: "Loading artifact",
  },
  empty: {
    description: "This artifact does not have any content to display yet.",
    icon: FileTextIcon,
    title: "Nothing to show yet",
  },
  error: {
    description: "The artifact could not be loaded. Try again in a moment.",
    icon: CircleAlertIcon,
    title: "Unable to load artifact",
  },
};

export function GenericArtifactDetailShell({
  artifactCommentDraftRequest,
  artifactCommentSelectionRequest,
  artifact,
  commentsOpen,
  details,
  initialComments,
  initialTab,
  initialTraceJumpRequest,
  initialVersion,
  onActiveTabChange,
  onCommentsOpenChange,
  onSelectArtifactComment,
  onSelectSessionComment,
  onVersionChange,
  panels,
  presentation,
  sessionDetail,
  sessionTrace = genericArtifactSessionTrace,
  tabs = ["artifact", "details", "sessions"],
}: GenericArtifactDetailShellProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>(
    initialTab ?? tabs[0] ?? "artifact"
  );
  const initialTabIsAvailable = initialTab ? tabs.includes(initialTab) : false;
  useEffect(() => {
    if (initialTab && initialTabIsAvailable) {
      setActiveTab(initialTab);
    }
  }, [initialTab, initialTabIsAvailable]);
  const [railAnimationEnabled, setRailAnimationEnabled] = useState(true);
  const [sessionComments, setSessionComments] = useState<
    GenericCommentRecord[]
  >(() =>
    initialComments?.sessions
      ? [...initialComments.sessions]
      : [
          {
            id: "session-comment-1",
            author: "Jordan Lee",
            body: "The revision session accounts for most of the rework cost in this trace.",
            anchorPreview: "Added the variant and a focused unit test:",
            context: "Address review feedback",
            time: "2 min ago",
            traceRow: 4,
            anchor: {
              type: "trace",
              traceRow: 4,
              quote: "Added the variant and a focused unit test:",
            },
            source: { provider: "native" },
            status: "open",
          },
        ]
  );
  const [generalComments, setGeneralComments] = useState<
    GenericCommentRecord[]
  >(() =>
    initialComments?.artifact
      ? [...initialComments.artifact]
      : [
          {
            id: "comment-1",
            author: "Andrew Eye",
            body: "This is a general artifact comment. Artifact-specific viewers can add anchored review behavior.",
            context: `${artifact.slug} · General artifact comment`,
            time: "8 min ago",
            anchor: { type: "artifact" },
            source: { provider: "native" },
            status: "open",
          },
          {
            id: "comment-2",
            author: "Parker Byrd",
            body: "The comments rail remains consistent while the center viewer or editor changes by artifact type.",
            context: "Shared artifact shell",
            time: "3 min ago",
            anchor: { type: "artifact" },
            source: { provider: "native" },
            status: "open",
          },
        ]
  );
  const [traceJumpRequest, setTraceJumpRequest] = useState<{
    commentId?: string;
    nonce: number;
    row: number;
  } | null>(initialTraceJumpRequest ?? null);

  useEffect(() => {
    if (initialTraceJumpRequest) {
      setTraceJumpRequest(initialTraceJumpRequest);
    }
  }, [initialTraceJumpRequest]);
  const commentsByTab = useRef({ artifact: commentsOpen, sessions: false });
  const commentsTransitionFrame = useRef<number | null>(null);
  const commentsLayoutModeRef = useRef<CommentsLayoutMode | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [commentsLayoutMode, setCommentsLayoutMode] =
    useState<CommentsLayoutMode>("wide");
  const [shellWidth, setShellWidth] = useState(1200);
  const [commentsWidth, setCommentsWidth] = useState(352);

  useEffect(
    () => () => {
      if (commentsTransitionFrame.current) {
        cancelAnimationFrame(commentsTransitionFrame.current);
      }
    },
    []
  );

  useEffect(() => {
    if (activeTab !== "details") {
      commentsByTab.current[activeTab] = commentsOpen;
    }
  }, [activeTab, commentsOpen]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const updateConstraint = (width: number) => {
      setShellWidth(width);
      const nextMode = commentsLayoutModeForWidth(width);
      const previousMode = commentsLayoutModeRef.current;
      commentsLayoutModeRef.current = nextMode;
      setCommentsLayoutMode(nextMode);
      if (
        shouldAutoCollapseComments({
          nextMode,
          open: commentsOpen,
          previousMode,
        })
      ) {
        onCommentsOpenChange(false);
      }
    };
    updateConstraint(shell.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        updateConstraint(entry.contentRect.width);
      }
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [commentsOpen, onCommentsOpenChange]);

  const changeTab = (nextTab: DetailTab) => {
    if (nextTab === activeTab) {
      return;
    }
    if (activeTab !== "details") {
      commentsByTab.current[activeTab] = commentsOpen;
    }
    if (commentsTransitionFrame.current) {
      cancelAnimationFrame(commentsTransitionFrame.current);
    }
    setRailAnimationEnabled(false);
    setActiveTab(nextTab);
    onActiveTabChange?.(nextTab);
    onCommentsOpenChange(
      nextTab !== "details" && commentsByTab.current[nextTab]
    );
    commentsTransitionFrame.current = requestAnimationFrame(() => {
      commentsTransitionFrame.current = requestAnimationFrame(() => {
        setRailAnimationEnabled(true);
      });
    });
  };

  let activePanel: ReactNode;
  if (activeTab === "artifact") {
    activePanel = panels?.artifact ? (
      <ArtifactReviewCanvas frame={presentation?.canvas?.frame}>
        {panels.artifact}
      </ArtifactReviewCanvas>
    ) : (
      <ArtifactCanvasPanel config={presentation?.canvas} />
    );
  } else if (activeTab === "details") {
    activePanel = panels?.details ?? (
      <CommonArtifactDetails
        artifact={artifact}
        initialVersion={initialVersion}
        onVersionChange={onVersionChange}
        presentation={details}
      />
    );
  } else {
    activePanel = panels?.sessions ?? (
      <ArtifactSessionsTrace
        artifact={artifact}
        commentAnchors={sessionComments.flatMap((comment) =>
          comment.traceRow == null
            ? []
            : [
                {
                  anchorPreview: comment.anchorPreview,
                  id: comment.id,
                  traceRow: comment.traceRow,
                },
              ]
        )}
        detailOverride={sessionDetail}
        onSubmitTraceComment={({ anchorPreview, body, traceRow }) => {
          setSessionComments((current) => [
            ...current,
            {
              author: "Andrew Eye",
              anchorPreview,
              body,
              context: `“${anchorPreview}”`,
              id: `session-comment-${Date.now()}`,
              time: "now",
              traceRow,
            },
          ]);
          commentsByTab.current.sessions = true;
          onCommentsOpenChange(true);
        }}
        trace={sessionTrace}
        traceJumpRequest={traceJumpRequest}
      />
    );
  }

  return (
    <Tabs
      className="relative min-h-0 flex-1 flex-row gap-0 max-md:pb-14"
      data-comments-layout={commentsLayoutMode}
      onValueChange={(value) => changeTab(value as DetailTab)}
      ref={shellRef}
      value={activeTab}
    >
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-end justify-between border-b px-4">
          <UnderlineTabsList
            aria-label="Artifact detail sections"
            className="w-auto border-b-0 px-0 pt-0"
          >
            {tabs.map((value) => (
              <UnderlineTabsTrigger
                className="h-10 px-3 py-0 text-sm"
                key={value}
                value={value}
              >
                {DETAIL_TAB_LABELS[value]}
              </UnderlineTabsTrigger>
            ))}
          </UnderlineTabsList>
          <div className="mb-2 flex items-center gap-2">
            {activeTab === "artifact"
              ? presentation?.actions?.map((action) => (
                  <Button
                    key={action.label}
                    onClick={action.onSelect}
                    size="sm"
                    variant={
                      action.variant === "primary" ? "default" : "outline"
                    }
                  >
                    {action.icon ? <action.icon /> : null}
                    {action.label}
                  </Button>
                ))
              : null}
            <ArtifactPeopleStack names={artifact.collaborators} />
          </div>
        </div>

        {activePanel}
      </section>

      {activeTab === "details" ? null : (
        <SharedArtifactCommentsRail
          activeTab={activeTab}
          animate={railAnimationEnabled}
          artifact={artifact}
          availableWidth={Math.max(220, shellWidth - 96)}
          config={presentation?.comments}
          draftRequest={artifactCommentDraftRequest}
          generalComments={generalComments}
          onOpenChange={onCommentsOpenChange}
          onSelectArtifactComment={onSelectArtifactComment}
          onSelectSessionComment={(commentId, row) => {
            setTraceJumpRequest({ commentId, nonce: Date.now(), row });
            onSelectSessionComment?.(commentId, row);
          }}
          onWidthChange={setCommentsWidth}
          open={commentsOpen}
          selectionRequest={artifactCommentSelectionRequest}
          sessionComments={sessionComments}
          setGeneralComments={setGeneralComments}
          setSessionComments={setSessionComments}
          width={commentsWidth}
        />
      )}
    </Tabs>
  );
}

const DETAIL_TAB_LABELS: Readonly<Record<DetailTab, string>> = {
  artifact: "Artifact",
  details: "Details",
  sessions: "Sessions",
};

function ArtifactCanvasPanel({
  config,
}: {
  config?: ArtifactShellPresentation["canvas"];
}) {
  const state = config?.state ?? "ready";
  const label = config?.label ?? "[Artifact Canvas]";

  if (state === "ready") {
    return (
      <ArtifactReviewCanvas state="ready">
        <div className="relative size-full">
          <span className="absolute top-4 left-4 text-muted-foreground/60 text-xs">
            {label}
          </span>
        </div>
      </ArtifactReviewCanvas>
    );
  }

  const content = {
    ...defaultArtifactShellStates[state],
    ...config?.[state],
  };
  const StateIcon = content.icon;

  return (
    <ArtifactReviewCanvas state={state}>
      <div className="relative flex size-full items-center justify-center p-8">
        <span className="absolute top-4 left-4 text-muted-foreground/60 text-xs">
          {label}
        </span>
        {state === "loading" ? (
          <div
            aria-live="polite"
            className="w-full max-w-sm space-y-5 text-center"
            role="status"
          >
            <StateIcon className="mx-auto size-5 animate-spin text-muted-foreground" />
            <div>
              <h2 className="font-medium text-sm">{content.title}</h2>
              <p className="mt-1 text-muted-foreground text-sm">
                {content.description}
              </p>
            </div>
            <div aria-hidden="true" className="space-y-2">
              <Skeleton className="mx-auto h-3 w-4/5" />
              <Skeleton className="mx-auto h-3 w-full" />
              <Skeleton className="mx-auto h-3 w-3/5" />
            </div>
          </div>
        ) : null}
        {state === "empty" ? (
          <div className="max-w-sm text-center">
            <StateIcon className="mx-auto size-6 text-muted-foreground" />
            <h2 className="mt-3 font-medium text-sm">{content.title}</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {content.description}
            </p>
            {content.action ? (
              <Button
                className="mt-4"
                onClick={content.action.onSelect}
                size="sm"
                variant={
                  content.action.variant === "secondary" ? "outline" : "default"
                }
              >
                {content.action.icon ? <content.action.icon /> : null}
                {content.action.label}
              </Button>
            ) : null}
          </div>
        ) : null}
        {state === "error" ? (
          <Alert className="max-w-md" variant="error">
            <StateIcon />
            <AlertTitle>{content.title}</AlertTitle>
            <AlertDescription>
              <p>{content.description}</p>
              {content.action ? (
                <Button
                  className="mt-2"
                  onClick={content.action.onSelect}
                  size="sm"
                  variant="outline"
                >
                  {content.action.icon ? <content.action.icon /> : null}
                  {content.action.label}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </ArtifactReviewCanvas>
  );
}

/**
 * Shared review surface for every artifact implementation. Specializations own
 * the content inside this frame, while the shell owns its boundary, spacing,
 * background, and resize relationship with the comments rail.
 */
export function ArtifactReviewCanvas({
  children,
  frame = "framed",
  state = "ready",
}: {
  children: ReactNode;
  frame?: "framed" | "flush";
  state?: ArtifactCanvasState;
}) {
  if (frame === "flush") {
    return (
      <div
        aria-label="Artifact viewer and editor canvas"
        className="min-h-0 flex-1 overflow-hidden bg-background"
        data-artifact-canvas-state={state}
        role="tabpanel"
      >
        {children}
      </div>
    );
  }

  return (
    <div
      aria-label="Artifact viewer and editor canvas"
      className="min-h-0 flex-1 bg-muted/30 p-4"
      role="tabpanel"
    >
      <div
        className="relative flex size-full min-h-0 flex-col overflow-hidden rounded-lg border bg-background shadow-sm"
        data-artifact-canvas-state={state}
      >
        {children}
      </div>
    </div>
  );
}
