// biome-ignore-all lint/style/noExcessiveLinesPerFile: This interaction prototype intentionally keeps the review state model together; PRD-568 records the production decomposition.

"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import { Input } from "@repo/design-system/components/ui/input";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { cn } from "@repo/design-system/lib/utils";
import {
  ExternalLinkIcon,
  EyeIcon,
  GlobeIcon,
  MessageSquareIcon,
  PanelRightIcon,
  XIcon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PrototypeStatus } from "@/lib/registry";
import { AnchoredAnnotationEditor } from "./components/anchored-annotation-editor";
import { AppShell } from "./components/app-shell";
import { PrototypeCommentThread } from "./components/prototype-comment-thread";
import { PrototypesTable } from "./components/prototypes-table";
import {
  type Annotation,
  type AnnotationEdits,
  type AnnotationTarget,
  initialAnnotations,
  type Person,
  type PrototypeRow,
  type PrototypeVersion,
  PrototypeVersionStatus,
  people,
  prototypes,
  prototypeVersions,
} from "./mock";
import { previewDocumentForVersion } from "./preview-document";
import { getOpenCommentCount, toggleResolvedAnnotation } from "./state";

export default function PrototypesPage() {
  const [prototypeRows, setPrototypeRows] = useState<PrototypeRow[]>([
    ...prototypes,
  ]);
  const [selected, setSelected] = useState<PrototypeRow | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [activeTab, setActiveTab] = useState("preview");
  const constrainedReview = useMediaQuery("(max-width: 1279px)");
  const updatePrototype = useCallback((nextPrototype: PrototypeRow) => {
    setSelected(nextPrototype);
    setPrototypeRows((current) =>
      current.map((item) =>
        item.id === nextPrototype.id ? nextPrototype : item
      )
    );
  }, []);

  useEffect(() => {
    if (constrainedReview && selected) {
      setCommentsOpen(false);
    }
  }, [constrainedReview, selected]);

  if (!selected) {
    return (
      <AppShell breadcrumbs={[{ label: "Prototypes", isCurrent: true }]}>
        <PrototypeList items={prototypeRows} onOpen={setSelected} />
      </AppShell>
    );
  }

  return (
    <Tabs className="contents" onValueChange={setActiveTab} value={activeTab}>
      <AppShell
        actions={
          activeTab === "preview" ? (
            <Button
              aria-controls="prototype-comments-rail"
              aria-expanded={commentsOpen}
              aria-label="Toggle comments panel"
              onClick={() => setCommentsOpen((value) => !value)}
              size="icon-sm"
              variant="ghost"
            >
              <PanelRightIcon />
            </Button>
          ) : undefined
        }
        breadcrumbs={[
          { label: "Prototypes", onSelect: () => setSelected(null) },
          { label: selected.name, isCurrent: true },
        ]}
        subheader={
          <UnderlineTabsList className="w-full shrink-0 pt-0">
            <UnderlineTabsTrigger value="preview">
              Prototype
            </UnderlineTabsTrigger>
            <UnderlineTabsTrigger value="details">Details</UnderlineTabsTrigger>
            <div className="ml-auto flex items-center pl-4">
              <AvatarStack
                people={[selected.owner, ...selected.collaborators]}
              />
            </div>
          </UnderlineTabsList>
        }
      >
        <PrototypeDetail
          commentsOpen={commentsOpen}
          onCommentsOpenChange={setCommentsOpen}
          onPreviewRequested={() => setActiveTab("preview")}
          onPrototypeChange={updatePrototype}
          prototype={selected}
        />
      </AppShell>
    </Tabs>
  );
}

function PrototypeList({
  items,
  onOpen,
}: {
  items: PrototypeRow[];
  onOpen: (prototype: PrototypeRow) => void;
}) {
  const [sortBy, setSortBy] = useState("featured");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const visible = useMemo(() => {
    return [...items].sort((a, b) =>
      comparePrototypeRows(a, b, sortBy, sortDir)
    );
  }, [items, sortBy, sortDir]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <PrototypesTable
          items={visible}
          onOpenDetail={onOpen}
          onSort={(column, direction) => {
            setSortBy(column);
            setSortDir(direction);
          }}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      </div>
    </div>
  );
}

function comparePrototypeRows(
  a: PrototypeRow,
  b: PrototypeRow,
  sortBy: string,
  sortDir: SortDirection
): number {
  if (sortBy === "featured") {
    return compareFeaturedPrototypes(a, b);
  }
  const aValue = prototypeSortValue(a, sortBy);
  const bValue = prototypeSortValue(b, sortBy);
  const direction = sortDir === "asc" ? 1 : -1;
  if (aValue < bValue) {
    return -1 * direction;
  }
  if (aValue > bValue) {
    return direction;
  }
  return 0;
}

function compareFeaturedPrototypes(a: PrototypeRow, b: PrototypeRow): number {
  if (a.id === "branches-v2") {
    return -1;
  }
  if (b.id === "branches-v2") {
    return 1;
  }
  return a.name.localeCompare(b.name);
}

function prototypeSortValue(
  item: PrototypeRow,
  sortBy: string
): string | number {
  switch (sortBy) {
    case "owner":
      return item.owner.name;
    case "tags":
      return item.tags.join(" ");
    case "status":
      return [
        PrototypeStatus.Draft,
        PrototypeStatus.InProgress,
        PrototypeStatus.ReadyForReview,
        PrototypeStatus.HandedOff,
      ].indexOf(item.status);
    case "version":
      return item.version;
    case "comments":
      return item.openComments;
    case "updated":
      return item.updatedAt;
    default:
      return item.name;
  }
}

function PrototypeDetail({
  prototype,
  commentsOpen,
  onCommentsOpenChange,
  onPrototypeChange,
  onPreviewRequested,
}: {
  prototype: PrototypeRow;
  commentsOpen: boolean;
  onCommentsOpenChange: (open: boolean) => void;
  onPrototypeChange: (prototype: PrototypeRow) => void;
  onPreviewRequested: () => void;
}) {
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] =
    useState<Annotation[]>(initialAnnotations);
  const [selectedTarget, setSelectedTarget] = useState<AnnotationTarget | null>(
    null
  );
  const [activeAnnotation, setActiveAnnotation] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState(prototype.version);
  const [annotationNavigationRequest, setAnnotationNavigationRequest] =
    useState(0);
  useEffect(() => {
    if (!selectedTarget) {
      return;
    }
    const cancelOutsideComposer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-annotation-editor]")
      ) {
        return;
      }
      setSelectedTarget(null);
    };
    window.addEventListener("pointerdown", cancelOutsideComposer);
    return () =>
      window.removeEventListener("pointerdown", cancelOutsideComposer);
  }, [selectedTarget]);

  const availableVersions: readonly PrototypeVersion[] =
    prototype.id === "branches-v2"
      ? prototypeVersions
      : [
          {
            number: prototype.version,
            label: `v${prototype.version}`,
            createdAt: prototype.updated,
            createdBy: prototype.updatedBy,
            status: PrototypeVersionStatus.Current,
            changeSummary: "Current published prototype.",
          },
        ];
  const visibleAnnotations = useMemo(
    () =>
      annotations.filter(
        (annotation) => annotation.version === selectedVersion
      ),
    [annotations, selectedVersion]
  );

  const activateAnnotation = (id: number) => {
    onPreviewRequested();
    setActiveAnnotation(id);
    setAnnotationNavigationRequest((request) => request + 1);
    setSelectedTarget(null);
    onCommentsOpenChange(true);
  };

  const addAnnotation = (body: string, proposedChanges?: AnnotationEdits) => {
    if (!selectedTarget) {
      return;
    }
    const nextId = Math.max(0, ...annotations.map((item) => item.id)) + 1;
    const nextDisplayNumber =
      Math.max(0, ...visibleAnnotations.map((item) => item.displayNumber)) + 1;
    setAnnotations((current) => [
      ...current,
      {
        id: nextId,
        displayNumber: nextDisplayNumber,
        version: selectedVersion,
        author: prototype.owner,
        body,
        anchorId: selectedTarget.anchorId,
        target: selectedTarget.target,
        selector: selectedTarget.selector,
        route: selectedTarget.route,
        createdAt: "just now",
        proposedChanges,
      },
    ]);
    setActiveAnnotation(null);
    setSelectedTarget(null);
    onCommentsOpenChange(true);
  };
  const resolveAnnotation = (id: number) => {
    setAnnotations((current) => toggleResolvedAnnotation(current, id));
  };
  const editAnnotation = (
    id: number,
    body: string,
    proposedChanges?: AnnotationEdits
  ) => {
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === id
          ? {
              ...annotation,
              body,
              proposedChanges: proposedChanges ?? annotation.proposedChanges,
            }
          : annotation
      )
    );
  };
  const deleteAnnotation = (id: number) => {
    setAnnotations((current) =>
      current.filter((annotation) => annotation.id !== id)
    );
    setActiveAnnotation((current) => (current === id ? null : current));
  };
  const replyToAnnotation = (id: number, body: string) => {
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === id
          ? {
              ...annotation,
              replies: [
                ...(annotation.replies ?? []),
                {
                  id: Date.now(),
                  author: prototype.owner,
                  body,
                  createdAt: "just now",
                },
              ],
            }
          : annotation
      )
    );
  };

  const browserControls = (
    <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
      <Select
        onValueChange={(value) => {
          const nextVersion = Number(value);
          setSelectedVersion(nextVersion);
          setActiveAnnotation(null);
          setSelectedTarget(null);
          setAnnotating(false);
        }}
        value={String(selectedVersion)}
      >
        <SelectTrigger
          aria-label="Prototype version"
          className="w-[9.5rem]"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {availableVersions.map((item) => (
            <SelectItem key={item.number} value={String(item.number)}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ToggleGroup
        aria-label="Prototype interaction mode"
        onValueChange={(value) => {
          if (!value) {
            return;
          }
          const nextAnnotating = value === "comment";
          setAnnotating(nextAnnotating);
          if (!nextAnnotating) {
            setSelectedTarget(null);
          }
        }}
        size="sm"
        type="single"
        value={annotating ? "comment" : "preview"}
        variant="outline"
      >
        <ToggleGroupItem value="preview">
          <EyeIcon />
          Preview
        </ToggleGroupItem>
        <ToggleGroupItem value="comment">
          <MessageSquareIcon />
          Comment
        </ToggleGroupItem>
      </ToggleGroup>
      <Button asChild size="icon-sm" variant="ghost">
        <a
          aria-label="Open hosted preview"
          href={prototype.previewUrl}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon />
        </a>
      </Button>
    </div>
  );
  const openVersionPreview = (versionNumber: number) => {
    setSelectedVersion(versionNumber);
    setActiveAnnotation(null);
    setSelectedTarget(null);
    setAnnotating(false);
    onPreviewRequested();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TabsContent
        className="relative min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        forceMount
        value="preview"
      >
        <div className="relative flex size-full min-h-0">
          <section className="relative min-w-0 flex-1">
            <BrowserFrame
              activeAnnotation={activeAnnotation}
              annotating={annotating}
              annotationNavigationRequest={annotationNavigationRequest}
              annotations={visibleAnnotations}
              controls={browserControls}
              onActivate={activateAnnotation}
              onAddAnnotation={addAnnotation}
              onCloseActiveAnnotation={() => setActiveAnnotation(null)}
              onEditAnnotation={editAnnotation}
              onSelectTarget={setSelectedTarget}
              prototype={prototype}
              selectedTarget={selectedTarget}
              version={selectedVersion}
            />
          </section>
          <CommentsRail
            activeAnnotation={activeAnnotation}
            annotations={visibleAnnotations}
            onActivate={activateAnnotation}
            onDelete={deleteAnnotation}
            onEdit={editAnnotation}
            onReply={replyToAnnotation}
            onResolve={resolveAnnotation}
            open={commentsOpen}
            prototype={prototype}
            version={selectedVersion}
          />
        </div>
      </TabsContent>

      <TabsContent
        className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden"
        forceMount
        value="details"
      >
        <PrototypeDetails
          annotations={annotations}
          onOpenVersion={openVersionPreview}
          onPrototypeChange={onPrototypeChange}
          prototype={prototype}
          versions={availableVersions}
        />
      </TabsContent>
    </div>
  );
}

function BrowserFrame({
  prototype,
  annotating,
  annotations,
  activeAnnotation,
  annotationNavigationRequest,
  controls,
  version,
  selectedTarget,
  onAddAnnotation,
  onCloseActiveAnnotation,
  onEditAnnotation,
  onSelectTarget,
  onActivate,
}: {
  prototype: PrototypeRow;
  annotating: boolean;
  annotations: Annotation[];
  activeAnnotation: number | null;
  annotationNavigationRequest: number;
  controls: ReactNode;
  version: number;
  selectedTarget: AnnotationTarget | null;
  onAddAnnotation: (body: string, proposedChanges?: AnnotationEdits) => void;
  onCloseActiveAnnotation: () => void;
  onEditAnnotation: (
    id: number,
    body: string,
    proposedChanges?: AnnotationEdits
  ) => void;
  onSelectTarget: (target: AnnotationTarget | null) => void;
  onActivate: (id: number) => void;
}) {
  type AnchorRect = {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  type BridgeAnchor = AnnotationTarget & { rect: AnchorRect };

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredAnchor, setHoveredAnchor] = useState<BridgeAnchor | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<number | null>(
    null
  );
  const [currentRoute, setCurrentRoute] = useState("/home");
  const currentRouteRef = useRef(currentRoute);
  currentRouteRef.current = currentRoute;
  const [anchorRects, setAnchorRects] = useState<Record<string, AnchorRect>>(
    {}
  );
  const activeThread = annotations.find(
    (annotation) => annotation.id === activeAnnotation
  );
  const hoveredThread = annotations.find(
    (annotation) => annotation.id === hoveredAnnotationId
  );
  const displayedThread = activeThread ?? hoveredThread;
  const activeRoute = activeThread?.route;
  const activeAnchorId = activeThread?.anchorId;

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) {
      return;
    }
    const synchronizeFrame = () => {
      frame.contentWindow?.postMessage(
        {
          source: "closedloop-prototype-host",
          type: "version",
          version,
          route: currentRouteRef.current,
        },
        "*"
      );
      frame.contentWindow?.postMessage(
        {
          source: "closedloop-prototype-host",
          type: "mode",
          enabled: annotating,
        },
        "*"
      );
    };
    frame.addEventListener("load", synchronizeFrame);
    return () => frame.removeEventListener("load", synchronizeFrame);
  }, [annotating, version]);

  useEffect(() => {
    const receiveHover = (anchor: BridgeAnchor | null) => {
      if (annotating && !selectedTarget) {
        setHoveredAnchor(anchor);
      }
    };
    const receiveSelection = (anchor: BridgeAnchor) => {
      if (!annotating) {
        return;
      }
      if (selectedTarget) {
        setHoveredAnchor(null);
        onSelectTarget(null);
        return;
      }
      setAnchorRects((current) => ({
        ...current,
        [anchor.anchorId]: anchor.rect,
      }));
      setHoveredAnchor(null);
      onSelectTarget(anchor);
    };
    const receiveBridgeMessage = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.data?.source !== "closedloop-prototype-bridge"
      ) {
        return;
      }
      switch (event.data.type) {
        case "layout": {
          setCurrentRoute(event.data.route as string);
          setAnchorRects(
            Object.fromEntries(
              (event.data.anchors as BridgeAnchor[]).map((anchor) => [
                anchor.anchorId,
                anchor.rect,
              ])
            )
          );
          break;
        }
        case "ready": {
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: "closedloop-prototype-host",
              type: "version",
              version,
            },
            "*"
          );
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: "closedloop-prototype-host",
              type: "mode",
              enabled: annotating,
            },
            "*"
          );
          const active = annotations.find(
            (annotation) => annotation.id === activeAnnotation
          );
          if (active) {
            iframeRef.current?.contentWindow?.postMessage(
              {
                source: "closedloop-prototype-host",
                type: "navigate",
                route: active.route,
                anchorId: active.anchorId,
              },
              "*"
            );
          }
          break;
        }
        case "route": {
          const nextRoute = event.data.route as string;
          setCurrentRoute(nextRoute);
          if (activeRoute && nextRoute !== activeRoute) {
            onCloseActiveAnnotation();
          }
          break;
        }
        case "hover": {
          receiveHover(event.data.anchor as BridgeAnchor | null);
          break;
        }
        case "select": {
          receiveSelection(event.data.anchor as BridgeAnchor);
          break;
        }
        case "clear-selection": {
          onSelectTarget(null);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("message", receiveBridgeMessage);
    return () => window.removeEventListener("message", receiveBridgeMessage);
  }, [
    activeAnnotation,
    activeRoute,
    annotating,
    annotations,
    onCloseActiveAnnotation,
    onSelectTarget,
    selectedTarget,
    version,
  ]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "closedloop-prototype-host",
        type: "mode",
        enabled: annotating,
      },
      "*"
    );
    if (!annotating) {
      setHoveredAnchor(null);
    }
  }, [annotating]);

  useEffect(() => {
    setAnchorRects({});
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "closedloop-prototype-host",
        type: "version",
        version,
        route: currentRouteRef.current,
      },
      "*"
    );
  }, [version]);

  useEffect(() => {
    if (!(activeRoute && activeAnchorId)) {
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "closedloop-prototype-host",
        type: "navigate",
        route: activeRoute,
        anchorId: activeAnchorId,
        requestId: annotationNavigationRequest,
      },
      "*"
    );
  }, [activeAnchorId, activeRoute, annotationNavigationRequest]);

  const selectedRect = selectedTarget
    ? anchorRects[selectedTarget.anchorId]
    : null;
  const displayedThreadRect = displayedThread
    ? anchorRects[displayedThread.anchorId]
    : null;

  const keepHoveredCommentOpen = (id: number) => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setHoveredAnnotationId(id);
  };
  const scheduleHoveredCommentClose = () => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
    }
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveredAnnotationId(null);
      hoverCloseTimerRef.current = null;
    }, 120);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-muted/30 p-4">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 rounded-t-lg border border-b-0 bg-background px-3 py-1.5 shadow-sm">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        </div>
        <div className="flex h-6 min-w-24 flex-1 basis-40 items-center gap-2 rounded-md bg-muted px-2 text-muted-foreground text-xs">
          <GlobeIcon className="size-3 shrink-0" />
          <span className="truncate">
            {prototype.previewUrl}
            {currentRoute === "/home" ? "" : currentRoute}
          </span>
        </div>
        {controls}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-lg border bg-white shadow-sm">
        <iframe
          className="size-full bg-white"
          key={`${prototype.id}-v${version}`}
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={previewDocumentForVersion(version)
            .replace("Hello, world.", prototype.name)
            .replace(
              "A simple place to explore pages, versions, and review comments.",
              prototype.description
            )}
          title={`${prototype.name} hosted preview`}
        />
        {!selectedTarget && displayedThread && displayedThreadRect ? (
          <div
            className="absolute z-30 max-h-[calc(100%-2rem)] w-96 max-w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border bg-background shadow-xl"
            data-annotation-editor
            onPointerEnter={() => keepHoveredCommentOpen(displayedThread.id)}
            onPointerLeave={scheduleHoveredCommentClose}
            style={{
              left: `clamp(1rem, ${displayedThreadRect.x + displayedThreadRect.width + 12}px, calc(100% - 25rem))`,
              top: `clamp(1rem, ${displayedThreadRect.y}px, calc(100% - 4rem))`,
            }}
          >
            <AnchoredAnnotationEditor
              initialBody={displayedThread.body}
              key={`thread:${displayedThread.id}:${displayedThread.body}`}
              onCancel={() => {
                setHoveredAnnotationId(null);
                onCloseActiveAnnotation();
              }}
              onSubmit={(body, proposedChanges) => {
                onEditAnnotation(displayedThread.id, body, proposedChanges);
                setHoveredAnnotationId(null);
                onCloseActiveAnnotation();
              }}
              target={{
                anchorId: displayedThread.anchorId,
                target: displayedThread.target,
                selector: displayedThread.selector,
                route: displayedThread.route,
                ...displayedThread.proposedChanges,
              }}
            />
          </div>
        ) : null}
        {selectedTarget && selectedRect ? (
          <div
            className="pointer-events-none absolute z-10 border-2 border-primary bg-primary/15"
            style={{
              left: selectedRect.x,
              top: selectedRect.y,
              width: selectedRect.width,
              height: selectedRect.height,
            }}
          />
        ) : null}
        {selectedTarget && selectedRect ? (
          <div
            className="absolute z-30 max-h-[calc(100%-2rem)] w-96 max-w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border bg-background shadow-xl"
            data-annotation-editor
            style={{
              left: `clamp(1rem, ${selectedRect.x + selectedRect.width + 12}px, calc(100% - 25rem))`,
              top: `clamp(1rem, ${selectedRect.y}px, calc(100% - 4rem))`,
            }}
          >
            <AnchoredAnnotationEditor
              key={`${selectedTarget.route}:${selectedTarget.anchorId}`}
              onCancel={() => onSelectTarget(null)}
              onSubmit={onAddAnnotation}
              target={selectedTarget}
            />
          </div>
        ) : null}
        {annotating &&
        hoveredAnchor &&
        hoveredAnchor.anchorId !== selectedTarget?.anchorId ? (
          <div
            className="pointer-events-none absolute z-10 border-2 border-primary bg-primary/10"
            style={{
              left: hoveredAnchor.rect.x,
              top: hoveredAnchor.rect.y,
              width: hoveredAnchor.rect.width,
              height: hoveredAnchor.rect.height,
            }}
          />
        ) : null}
        {annotations.map((annotation, annotationIndex) =>
          anchorRects[annotation.anchorId] ? (
            <button
              aria-label={`Open comment ${annotation.displayNumber} on ${annotation.target}`}
              className={cn(
                "absolute z-20 flex size-6 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-xs shadow-sm ring-2 ring-background",
                activeAnnotation === annotation.id && "ring-ring"
              )}
              key={annotation.id}
              onClick={() => {
                setHoveredAnnotationId(null);
                onActivate(annotation.id);
              }}
              onPointerEnter={() => keepHoveredCommentOpen(annotation.id)}
              onPointerLeave={scheduleHoveredCommentClose}
              style={{
                left: Math.max(
                  4,
                  Math.min(
                    anchorRects[annotation.anchorId].x +
                      anchorRects[annotation.anchorId].width -
                      8,
                    (iframeRef.current?.clientWidth ?? 32) - 28
                  )
                ),
                top: Math.max(
                  4,
                  anchorRects[annotation.anchorId].y -
                    8 +
                    annotations
                      .slice(0, annotationIndex)
                      .filter((item) => item.anchorId === annotation.anchorId)
                      .length *
                      28
                ),
              }}
              type="button"
            >
              {annotation.displayNumber}
            </button>
          ) : null
        )}
      </div>
    </div>
  );
}

function CommentsRail({
  activeAnnotation,
  annotations,
  prototype,
  version,
  open,
  onActivate,
  onDelete,
  onEdit,
  onReply,
  onResolve,
}: {
  activeAnnotation: number | null;
  annotations: Annotation[];
  prototype: PrototypeRow;
  version: number;
  open: boolean;
  onActivate: (id: number) => void;
  onDelete: (id: number) => void;
  onEdit: (id: number, body: string, proposedChanges?: AnnotationEdits) => void;
  onReply: (id: number, body: string) => void;
  onResolve: (id: number) => void;
}) {
  const [generalComments, setGeneralComments] = useState<
    Array<{ id: number; body: string; version: number }>
  >([]);
  const railContentRef = useRef<HTMLDivElement>(null);
  const visibleGeneralComments = generalComments.filter(
    (comment) => comment.version === version
  );
  const openCount =
    getOpenCommentCount(annotations) + visibleGeneralComments.length;
  const totalCount = annotations.length + visibleGeneralComments.length;

  useEffect(() => {
    if (activeAnnotation === null) {
      return;
    }
    railContentRef.current
      ?.querySelector(`[data-comment-id="${activeAnnotation}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeAnnotation]);

  return (
    <aside
      className={cn(
        "absolute inset-y-0 right-0 z-40 flex w-[20rem] shrink-0 flex-col border-l bg-background shadow-lg xl:static xl:z-auto xl:w-[22rem] xl:shadow-none",
        !open && "hidden"
      )}
      id="prototype-comments-rail"
    >
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <MessageSquareIcon className="size-4 text-muted-foreground" />
        <h2 className="font-medium text-sm">Prototype comments</h2>
        <Chip className="ml-1" variant="muted">
          {openCount}/{totalCount}
        </Chip>
      </div>
      <div
        className="min-h-0 flex-1 space-y-3 overflow-auto p-3"
        ref={railContentRef}
      >
        {annotations.map((annotation) => (
          <PrototypeCommentThread
            annotation={annotation}
            key={annotation.id}
            onActivate={() => onActivate(annotation.id)}
            onDelete={() => onDelete(annotation.id)}
            onEdit={(body) => onEdit(annotation.id, body)}
            onReply={(body) => onReply(annotation.id, body)}
            onResolve={() => onResolve(annotation.id)}
            selected={activeAnnotation === annotation.id}
          />
        ))}
        {visibleGeneralComments.map((comment) => (
          <div className="rounded-lg border p-3" key={comment.id}>
            <div className="flex items-center gap-2">
              <AvatarLabel person={prototype.owner} />
              <span className="font-medium text-sm">
                {prototype.owner.name}
              </span>
              <span className="ml-auto text-muted-foreground text-xs">
                just now
              </span>
            </div>
            <p className="mt-2 text-sm">{comment.body}</p>
            <p className="mt-2 text-muted-foreground text-xs">
              General comment on v{version}
            </p>
          </div>
        ))}
      </div>
      <div className="border-t p-3">
        <CommentComposer
          key={`general-comment-v${version}`}
          minHeightClassName="min-h-16"
          onSubmit={(body) =>
            setGeneralComments((current) => [
              ...current,
              { id: current.length + 1, body, version },
            ])
          }
          placeholder="Add a comment and @mention someone…"
        />
      </div>
    </aside>
  );
}

function PrototypeDetails({
  prototype,
  versions,
  annotations,
  onPrototypeChange,
  onOpenVersion,
}: {
  prototype: PrototypeRow;
  versions: readonly PrototypeVersion[];
  annotations: Annotation[];
  onPrototypeChange: (prototype: PrototypeRow) => void;
  onOpenVersion: (version: number) => void;
}) {
  const [name, setName] = useState(prototype.name);
  const [status, setStatus] = useState(prototype.status);
  const [project, setProject] = useState(prototype.project);
  const [relatedFeature, setRelatedFeature] = useState(
    "PRD-568 Prototypes as Artifacts"
  );
  const [tags, setTags] = useState(prototype.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [ownerId, setOwnerId] = useState(prototype.owner.id);
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const mountedDetails = useRef(false);
  const ownerOptions = Object.values(people);
  const editableState = [
    name,
    ownerId,
    project,
    relatedFeature,
    status,
    tags.join(","),
  ].join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: editableState is the intentional persistence trigger.
  useEffect(() => {
    if (!editableState) {
      return;
    }
    if (!mountedDetails.current) {
      mountedDetails.current = true;
      return;
    }
    const owner =
      ownerOptions.find((person) => person.id === ownerId) ?? prototype.owner;
    onPrototypeChange({
      ...prototype,
      name,
      owner,
      project,
      status,
      tags,
    });
    setSaveState("saving");
    const saveTimer = setTimeout(() => setSaveState("saved"), 600);
    return () => clearTimeout(saveTimer);
  }, [editableState]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            Prototype
          </p>
          <Input
            aria-label="Prototype name"
            className="mt-1 h-10 w-[30rem] max-w-full font-semibold text-xl tracking-tight"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <p className="mt-2 max-w-3xl text-muted-foreground text-sm">
            {prototype.description}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            aria-live="polite"
            className="min-w-12 text-right text-muted-foreground text-xs"
          >
            {saveState === "saving" ? "Saving…" : "Saved"}
          </span>
          <Select
            onValueChange={(value) =>
              setStatus(
                value as (typeof PrototypeStatus)[keyof typeof PrototypeStatus]
              )
            }
            value={status}
          >
            <SelectTrigger aria-label="Prototype status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={PrototypeStatus.Draft}>Draft</SelectItem>
              <SelectItem value={PrototypeStatus.InProgress}>
                In progress
              </SelectItem>
              <SelectItem value={PrototypeStatus.ReadyForReview}>
                Ready for review
              </SelectItem>
              <SelectItem value={PrototypeStatus.HandedOff}>
                Handed off
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-8 grid gap-5">
        <section className="rounded-xl border bg-background">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-sm">Artifact details</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Core identity and relationships for this prototype.
            </p>
          </div>
          <dl className="grid gap-x-10 gap-y-6 p-5 sm:grid-cols-2">
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Project
              </dt>
              <dd className="mt-1">
                <Select onValueChange={setProject} value={project}>
                  <SelectTrigger aria-label="Project" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Ideas Triage">Ideas Triage</SelectItem>
                    <SelectItem value="Symphony Alpha">
                      Symphony Alpha
                    </SelectItem>
                    <SelectItem value="Documents">Documents</SelectItem>
                    <SelectItem value="Desktop">Desktop</SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Related feature
              </dt>
              <dd className="mt-1">
                <Select
                  onValueChange={setRelatedFeature}
                  value={relatedFeature}
                >
                  <SelectTrigger
                    aria-label="Related feature"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRD-568 Prototypes as Artifacts">
                      PRD-568 Prototypes as Artifacts
                    </SelectItem>
                    <SelectItem value="PRD-521 Branch details">
                      PRD-521 Branch details
                    </SelectItem>
                    <SelectItem value="None">None</SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="font-medium text-muted-foreground text-xs">
                Preview URL
              </dt>
              <dd className="mt-1 flex min-w-0 items-center gap-2">
                <a
                  className="min-w-0 flex-1 truncate text-primary text-sm hover:underline"
                  href={prototype.previewUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {prototype.previewUrl}
                </a>
                <Button asChild size="icon-sm" variant="ghost">
                  <a
                    aria-label="Open preview URL"
                    href={prototype.previewUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLinkIcon />
                  </a>
                </Button>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Tags
              </dt>
              <dd className="mt-2 flex flex-wrap items-center gap-1.5">
                {tags.map((tag) => (
                  <Chip className="gap-1" key={tag} variant="muted">
                    {tag}
                    <button
                      aria-label={`Remove ${tag} tag`}
                      onClick={() =>
                        setTags((current) =>
                          current.filter((item) => item !== tag)
                        )
                      }
                      type="button"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Chip>
                ))}
                <Input
                  aria-label="Add tag"
                  className="h-7 w-28"
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }
                    event.preventDefault();
                    const nextTag = tagDraft.trim();
                    if (nextTag && !tags.includes(nextTag)) {
                      setTags((current) => [...current, nextTag]);
                    }
                    setTagDraft("");
                  }}
                  placeholder="Add tag"
                  value={tagDraft}
                />
              </dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Last activity
              </dt>
              <dd className="mt-1 text-sm">
                {prototype.updated} by {prototype.updatedBy.name}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border bg-background">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-sm">People</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Artifact ownership and participation.
            </p>
          </div>
          <div className="grid gap-8 p-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <div>
              <p className="font-medium text-muted-foreground text-xs">Owner</p>
              <Select onValueChange={setOwnerId} value={ownerId}>
                <SelectTrigger aria-label="Owner" className="mt-3 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ownerOptions.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-medium text-muted-foreground text-xs">
                  Collaborators
                </p>
                <Chip variant="muted">Derived participation</Chip>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
                {prototype.collaborators.map((person) => (
                  <PersonLabel key={person.id} person={person} />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border bg-background">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-sm">Version history</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Immutable version metadata, authorship, and version-scoped review
              activity.
            </p>
          </div>
          <div className="overflow-x-auto">
            <div className="grid min-w-[56rem] grid-cols-[5rem_minmax(12rem,1fr)_11rem_8rem_8rem_8rem] border-b bg-muted/40 px-5 py-2 font-medium text-muted-foreground text-xs">
              <span>Version</span>
              <span>Change summary</span>
              <span>Author</span>
              <span>Published</span>
              <span>Open comments</span>
              <span className="text-right">Preview</span>
            </div>
            <div className="min-w-[56rem]">
              {versions.map((item) => {
                const commentCount = annotations.filter(
                  (annotation) =>
                    annotation.version === item.number && !annotation.resolved
                ).length;
                return (
                  <div
                    className="grid min-h-14 grid-cols-[5rem_minmax(12rem,1fr)_11rem_8rem_8rem_8rem] items-center border-b px-5 text-sm last:border-b-0"
                    key={item.number}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      {item.label}
                      {item.number === prototype.version ? (
                        <span className="size-1.5 rounded-full bg-success" />
                      ) : null}
                    </span>
                    <span className="truncate pr-6 text-muted-foreground">
                      {item.changeSummary}
                    </span>
                    <PersonLabel person={item.createdBy} />
                    <span className="text-muted-foreground text-xs">
                      {item.createdAt}
                    </span>
                    <span>
                      <Chip className="gap-1" variant="muted">
                        <MessageSquareIcon className="size-3" />
                        {commentCount}
                      </Chip>
                    </span>
                    <span className="flex justify-end">
                      {item.number === prototype.version ? (
                        <span className="text-muted-foreground text-xs">
                          Current
                        </span>
                      ) : (
                        <Button
                          onClick={() => onOpenVersion(item.number)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <EyeIcon />
                          Open preview
                        </Button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function AvatarLabel({ person }: { person: Person }) {
  return (
    <Avatar className="size-7">
      <AvatarFallback className={cn("text-[10px]", person.color)}>
        {person.initials}
      </AvatarFallback>
    </Avatar>
  );
}

function PersonLabel({ person }: { person: Person }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <AvatarLabel person={person} />
      <span className="truncate">{person.name}</span>
    </span>
  );
}

function AvatarStack({
  people,
  compact = false,
  maxVisible = people.length,
  wrap = false,
}: {
  people: Person[];
  compact?: boolean;
  maxVisible?: number;
  wrap?: boolean;
}) {
  const visiblePeople = people.slice(0, maxVisible);
  const hiddenPeople = people.slice(maxVisible);

  return (
    <span
      className={cn(
        "flex",
        wrap ? "max-w-32 flex-wrap gap-1.5" : "-space-x-1.5"
      )}
    >
      {visiblePeople.map((person) => (
        <Tooltip key={person.id}>
          <TooltipTrigger asChild>
            <button
              aria-label={person.name}
              className="rounded-full ring-2 ring-background"
              type="button"
            >
              <Avatar className={compact ? "size-5" : "size-7"}>
                <AvatarFallback className={cn("text-xs", person.color)}>
                  {person.initials}
                </AvatarFallback>
              </Avatar>
            </button>
          </TooltipTrigger>
          <TooltipContent>{person.name}</TooltipContent>
        </Tooltip>
      ))}
      {hiddenPeople.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={hiddenPeople.map((person) => person.name).join(", ")}
              className={cn(
                "flex items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background",
                compact ? "size-5 text-xs" : "size-7 text-xs"
              )}
              type="button"
            >
              +{hiddenPeople.length}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {hiddenPeople.map((person) => person.name).join(", ")}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
