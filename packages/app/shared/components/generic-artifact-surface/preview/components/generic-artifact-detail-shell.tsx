"use client";

import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import {
  ArtifactDetailShell,
  ArtifactDetailTabStateKind,
  resolveArtifactDetailTab,
} from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import {
  ArtifactTab,
  type ArtifactTabAction,
  type ArtifactTabFrame,
  type ArtifactTabState,
  type ArtifactTabStateContent,
} from "@repo/app/shared/components/artifact-detail-shell/artifact-tab";
import {
  Collaborators,
  collaboratorsFromNames,
} from "@repo/app/shared/components/collaborators";
import {
  ARTIFACT_DETAIL_TABS,
  ArtifactDetailTab as ArtifactDetailTabKey,
} from "@repo/app/shared/lib/artifact-detail-tab";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CommentsPaneLayout,
  type CommentsPaneLayout as CommentsPaneLayoutValue,
} from "../../../comments/comments-pane-model";
import { useCommentsTabMemory } from "../../../comments/comments-tab-memory";
import { useCommentsPaneDrafts } from "../../../comments/use-comments-pane-drafts";
import {
  type ArtifactSessionTrace,
  type GenericArtifact,
  genericArtifactSessionTrace,
} from "../fixtures";
import {
  type ArtifactCommentsPresentation,
  type GenericCommentRecord,
  ArtifactCommentsRail as SharedArtifactCommentsRail,
} from "./artifact-comments-rail";
import {
  type ArtifactDetailsPresentation,
  CommonArtifactDetails,
} from "./artifact-detail-sections";
import { ArtifactSessionsTrace } from "./artifact-sessions-trace";
import {
  type CommentsLayoutMode,
  commentsLayoutModeForWidth,
  shouldAutoCollapseComments,
} from "./comments-layout-model";
import type { SessionDetail } from "./experimental/session/mock-detail";

const HIDDEN_COMMENT_TABS: readonly DetailTab[] = ["details"];

const PANE_LAYOUT_FOR_MODE: Record<
  CommentsLayoutMode,
  CommentsPaneLayoutValue
> = {
  compact: CommentsPaneLayout.Narrow,
  mobile: CommentsPaneLayout.Mobile,
  wide: CommentsPaneLayout.Wide,
};

// The prototype keeps its historical name for the shared tab union.
export type DetailTab = ArtifactDetailTabKey;

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

// The canvas vocabulary is the shared Artifact tab's (ISS-10791); these names
// are kept for the prototype's existing importers.
export type ArtifactCanvasState = ArtifactTabState;
export type ArtifactShellAction = ArtifactTabAction;

export type ArtifactShellPresentation = {
  actions?: readonly ArtifactShellAction[];
  canvas?: {
    /**
     * `flush` lets an artifact-native frame (for example the prototype
     * browser) become the canvas boundary instead of nesting it inside a
     * second padded card.
     */
    frame?: ArtifactTabFrame;
    empty?: ArtifactTabStateContent;
    error?: ArtifactTabStateContent;
    loading?: ArtifactTabStateContent;
    permission?: ArtifactTabStateContent & {
      description: string;
      title: string;
    };
    /**
     * Text of the prototype's stand-in canvas when no `panels.artifact` is
     * passed. Not the region's accessible name, which is ArtifactTab's
     * `label`.
     */
    placeholder?: string;
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
  /** The page's comments toggle, which gets focus back when the rail dismisses. */
  commentsReturnFocusRef?: RefObject<HTMLElement | null>;
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

export function GenericArtifactDetailShell({
  artifactCommentDraftRequest,
  artifactCommentSelectionRequest,
  artifact,
  commentsOpen,
  commentsReturnFocusRef,
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
  tabs = ARTIFACT_DETAIL_TABS,
}: GenericArtifactDetailShellProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>(
    initialTab ?? tabs[0] ?? "artifact"
  );
  // The tab actually on screen: the shell falls back to the first configured
  // tab when `activeTab` names one this kind lacks, so the rail and its
  // per-tab memory must follow the same tab, not the raw state.
  const shownTab =
    resolveArtifactDetailTab(activeTab, tabs) ?? ArtifactDetailTabKey.Artifact;
  const initialTabIsAvailable = initialTab ? tabs.includes(initialTab) : false;
  useEffect(() => {
    if (initialTab && initialTabIsAvailable) {
      setActiveTab(initialTab);
    }
  }, [initialTab, initialTabIsAvailable]);
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
              kind: CommentAnchorKind.Trace,
              row: 4,
              selectedText: "Added the variant and a focused unit test:",
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
            author: "Ottilie Eastwick",
            body: "This is a general artifact comment. Artifact-specific viewers can add anchored review behavior.",
            context: `${artifact.slug} · General artifact comment`,
            time: "8 min ago",
            anchor: { kind: CommentAnchorKind.Artifact },
            source: { provider: "native" },
            status: "open",
          },
          {
            id: "comment-2",
            author: "Pascoe Birchall",
            body: "The comments rail remains consistent while the center viewer or editor changes by artifact type.",
            context: "Shared artifact shell",
            time: "3 min ago",
            anchor: { kind: CommentAnchorKind.Artifact },
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
  const commentsTabMemory = useCommentsTabMemory<DetailTab>(
    { artifact: commentsOpen },
    HIDDEN_COMMENT_TABS
  );
  // Drafts live here, above the rail, so closing it or visiting Details keeps them.
  const artifactDrafts = useCommentsPaneDrafts(artifact.id);
  const sessionDrafts = useCommentsPaneDrafts(artifact.id);
  const commentsLayoutModeRef = useRef<CommentsLayoutMode | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [commentsLayoutMode, setCommentsLayoutMode] =
    useState<CommentsLayoutMode>("wide");
  const [shellWidth, setShellWidth] = useState(1200);
  const [commentsWidth, setCommentsWidth] = useState(352);

  useEffect(() => {
    commentsTabMemory.remember(shownTab, commentsOpen);
  }, [commentsTabMemory, shownTab, commentsOpen]);

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
    if (nextTab === shownTab) {
      return;
    }
    const nextOpen = commentsTabMemory.changeTab(
      shownTab,
      nextTab,
      commentsOpen
    );
    setActiveTab(nextTab);
    onActiveTabChange?.(nextTab);
    onCommentsOpenChange(nextOpen);
  };

  const sessionsPanel = panels?.sessions ?? (
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
            author: "Ottilie Eastwick",
            anchorPreview,
            body,
            context: `“${anchorPreview}”`,
            id: `session-comment-${Date.now()}`,
            time: "now",
            traceRow,
          },
        ]);
        commentsTabMemory.remember("sessions", true);
        onCommentsOpenChange(true);
      }}
      trace={sessionTrace}
      traceJumpRequest={traceJumpRequest}
    />
  );

  return (
    <div
      // max-md:pb-14 keeps the panel clear of the prototype's mobile rail
      // toggle -- a host layout concern, not the shared shell's.
      className="flex min-h-0 flex-1 flex-col max-md:pb-14"
      data-comments-layout={commentsLayoutMode}
      ref={shellRef}
    >
      <ArtifactDetailShell
        activeTab={activeTab}
        comments={
          shownTab === "details" ? null : (
            <SharedArtifactCommentsRail
              activeTab={shownTab}
              artifact={artifact}
              availableWidth={Math.max(220, shellWidth - 96)}
              config={presentation?.comments}
              draftRequest={artifactCommentDraftRequest}
              {...(shownTab === "sessions" ? sessionDrafts : artifactDrafts)}
              generalComments={generalComments}
              layout={PANE_LAYOUT_FOR_MODE[commentsLayoutMode]}
              onOpenChange={onCommentsOpenChange}
              onSelectArtifactComment={onSelectArtifactComment}
              onSelectSessionComment={(commentId, row) => {
                setTraceJumpRequest({ commentId, nonce: Date.now(), row });
                onSelectSessionComment?.(commentId, row);
              }}
              onWidthChange={setCommentsWidth}
              open={commentsOpen}
              returnFocusRef={commentsReturnFocusRef}
              selectionRequest={artifactCommentSelectionRequest}
              sessionComments={sessionComments}
              setGeneralComments={setGeneralComments}
              setSessionComments={setSessionComments}
              width={commentsWidth}
            />
          )
        }
        headerActions={presentation?.actions?.map((action) => (
          <Button
            key={action.label}
            onClick={action.onSelect}
            size="sm"
            variant={action.variant === "primary" ? "default" : "outline"}
          >
            {action.icon ? <action.icon /> : null}
            {action.label}
          </Button>
        ))}
        headerEnd={
          <Collaborators
            people={collaboratorsFromNames(artifact.collaborators)}
          />
        }
        onActiveTabChange={changeTab}
        panels={{
          activity: panels?.activity ?? null,
          artifact: (
            <ArtifactTab
              canvas={
                panels?.artifact ?? (
                  // Prototype-only placeholder; real canvases come from each
                  // type's adapter (ISS-10796/10797).
                  <span className="p-4 text-muted-foreground/60 text-xs">
                    {presentation?.canvas?.placeholder ?? "[Artifact Canvas]"}
                  </span>
                )
              }
              frame={presentation?.canvas?.frame}
              // A new artifact starts its canvas lifecycle from first paint.
              key={artifact.id}
              state={presentation?.canvas?.state}
              stateContent={{
                empty: presentation?.canvas?.empty,
                error: presentation?.canvas?.error,
                loading: presentation?.canvas?.loading,
                permission: presentation?.canvas?.permission,
              }}
            />
          ),
          details: panels?.details ?? (
            <CommonArtifactDetails
              artifact={artifact}
              initialVersion={initialVersion}
              onVersionChange={onVersionChange}
              presentation={details}
            />
          ),
          sessions: sessionsPanel,
        }}
        tabStates={
          panels?.activity
            ? undefined
            : {
                // Sandbox-only copy. ISS-10790 AC 7 allows "an explicitly
                // labeled fixture slot" until ISS-10843/10844 ship, and
                // PLN-2072 v3 names it a "design pending" placeholder. The
                // shared shell ships no wording; production hosts supply
                // their own.
                [ArtifactDetailTabKey.Activity]: {
                  description:
                    "The Activity feed is being designed in ISS-10843.",
                  kind: ArtifactDetailTabStateKind.Unsupported,
                  title: "Activity design pending",
                },
              }
        }
        tabs={tabs}
      />
    </div>
  );
}
