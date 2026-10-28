"use client";
import { cn } from "@repo/design-system/lib/utils";
import { GlobeIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  Annotation,
  AnnotationEdits,
  AnnotationTarget,
  PrototypeRow,
} from "../mock";
import { previewDocumentForVersion } from "../preview-document";
import { AnchoredAnnotationEditor } from "./anchored-annotation-editor";
export function PrototypeBrowserFrame({
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
    globalThis.window.addEventListener("message", receiveBridgeMessage);
    return () =>
      globalThis.window.removeEventListener("message", receiveBridgeMessage);
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
