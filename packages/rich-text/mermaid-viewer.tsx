"use client";

/**
 * Mermaid diagram viewer with pan, zoom, fullscreen, export, and a navigation
 * minimap. Consumed by the Tiptap mermaid node view.
 *
 * ARCHITECTURE
 * ------------
 *   <MermaidViewer>      Public component. Owns the fullscreen wrapper ref.
 *       │
 *       └─ <ViewerCore>  Pan/zoom state and gesture handling; renders the
 *                        canvas + toolbar + minimap.
 *              │
 *              ├─ <ViewerToolbar>  Zoom %, fit, fullscreen, download, edit.
 *              └─ <Minimap>        Thumbnail + viewport rectangle.
 *
 * Pure math and SVG normalization live in `./mermaid-viewer-utils`. DOM-side
 * effects (ResizeObserver, MutationObserver, CTM inversion, Fullscreen API)
 * live in `./mermaid-viewer-hooks`.
 *
 * COORDINATE SYSTEMS
 * ------------------
 *   1. SVG user space (viewBox coords).
 *   2. Container-local (CSS pixels, origin at the container's top-left).
 *   3. Screen / viewport (CSS pixels).
 *
 * The content <div> has `position: absolute; top: 0; left: 0` inside the
 * container and `transform: translate(tx, ty) scale(s)` with
 * `transform-origin: top-left`. An SVG point (sx, sy) lands at container-
 * local (tx + sx * s, ty + sy * s). For the inverse (screen → SVG) we use
 * the browser's `svg.getScreenCTM().inverse()` rather than reconstructing it
 * ourselves; that picks up viewBox offsets, ancestor transforms, and any
 * internal <g> transforms mermaid might add.
 *
 * KNOWN GOTCHAS / NOTABLE FIXES
 * -----------------------------
 * - Mermaid flowcharts use `foreignObject` for node labels. Those have two
 *   consequences we work around:
 *     a) `fitNodeLabels` shrinks the font when the wrapped HTML overflows the
 *        foreignObject height — mermaid's text measurement assumes no wrap.
 *     b) PNG export via blob URL + <img> + canvas produces a tainted canvas
 *        when the SVG contains foreignObject. We encode to a base64 data URL
 *        instead (same-origin, no taint). See `exportPng` in utils.
 * - The minimap <img> can inherit large vertical margins from the editor's
 *   typography/prose CSS. A className like `m-0` isn't specific enough — we
 *   set `margin: 0` inline.
 * - Mermaid re-renders the SVG on theme mount and under React strict mode's
 *   double-invoke; a `MutationObserver` on the content div runs
 *   `fitNodeLabels` + measurement after every replacement.
 *
 * FILE LAYOUT
 * -----------
 *   1. MermaidViewer — the public entry point
 *   2. ViewerCore    — the main component with all the pan/zoom logic
 *   3. ToolbarButton / ViewerToolbar — presentational helpers
 *   4. Minimap       — thumbnail + viewport rectangle
 *
 * TypeScript function declarations are hoisted, so forward references among
 * these components are fine.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  Download,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useContainerSize,
  useFullscreen,
  useLatestRef,
  useSvgMeasurements,
  useVisibleRegion,
} from "./mermaid-viewer-hooks";
import {
  centerOnSvgPoint,
  computeFitTransform,
  cropSvgToBBox,
  exportPng,
  exportSvg,
  INLINE_HEIGHT,
  MAX_SCALE,
  MIN_SCALE,
  prepareSvg,
  type Transform,
  ZOOM_FACTOR,
  zoomAtPoint,
} from "./mermaid-viewer-utils";

type MermaidViewerProps = {
  svg: string;
  onEdit: () => void;
};

/**
 * Public entry point for the mermaid viewer. Owns the wrapper `<div>` that
 * the Fullscreen API targets and the `isFullscreen` state (kept in sync with
 * `document.fullscreenElement`). All visible behavior lives in `ViewerCore`.
 *
 * @param svg    Raw SVG markup from `mermaid.render(...)`.
 * @param onEdit Invoked when the toolbar's Edit Source button is clicked.
 */
export function MermaidViewer({ svg, onEdit }: Readonly<MermaidViewerProps>) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(wrapperRef);

  return (
    // Apply a background only in fullscreen so the page chrome doesn't bleed
    // through. Inline mode inherits the enclosing card's background.
    <div className={isFullscreen ? "bg-background" : ""} ref={wrapperRef}>
      <ViewerCore
        isFullscreen={isFullscreen}
        onEdit={onEdit}
        onToggleFullscreen={toggleFullscreen}
        svg={svg}
      />
    </div>
  );
}

/**
 * Core viewer: manages pan/zoom state, DOM measurement, and renders the
 * canvas + toolbar + minimap. Does NOT own fullscreen state — that lives in
 * the outer `MermaidViewer`.
 */
function ViewerCore({
  svg,
  isFullscreen,
  onEdit,
  onToggleFullscreen,
}: Readonly<{
  svg: string;
  isFullscreen?: boolean;
  onEdit?: () => void;
  onToggleFullscreen: () => void;
}>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({
    scale: 1,
    x: 0,
    y: 0,
  });
  // Scale produced by the most recent fit-to-view. Used to decide when to
  // show the minimap (only once the user has zoomed >20% past fit).
  const [initialScale, setInitialScale] = useState(1);
  const [cursorGrabbing, setCursorGrabbing] = useState(false);

  // Latest-value refs read by imperative handlers (wheel, pointer, zoom
  // callbacks) so they don't have to depend on reactive state.
  const transformRef = useLatestRef(transform);
  const scaleRef = useLatestRef(transform.scale);

  // Non-reactive state for the pan gesture. Tracking this in state would
  // trigger a re-render on every pointer-move, which we explicitly don't want.
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  // Guards "apply the initial fit-to-view exactly once".
  const hasInitialFitRef = useRef(false);

  const containerSize = useContainerSize(containerRef);
  const { html: processedSvg, dims: svgDimensions } = useMemo(
    () => prepareSvg(svg),
    [svg]
  );
  const { naturalSize, contentBBox } = useSvgMeasurements(contentRef, scaleRef);
  // The `trigger` value only needs to change when a remeasurement is needed.
  // We memo it so effects running inside the hook don't re-fire for unrelated
  // renders.
  const visibleRegionTrigger = useMemo(
    () => ({ transform, containerSize, naturalSize }),
    [transform, containerSize, naturalSize]
  );
  const visibleRegion = useVisibleRegion({
    containerRef,
    contentRef,
    trigger: visibleRegionTrigger,
  });

  const minimapSvgString = useMemo(
    () =>
      contentBBox ? cropSvgToBBox(processedSvg, contentBBox) : processedSvg,
    [processedSvg, contentBBox]
  );
  const minimapDataUri = useMemo(
    () =>
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(minimapSvgString)}`,
    [minimapSvgString]
  );

  // Initial fit-to-view. Runs on mount and on fullscreen toggle, but only
  // *applies* the fit on the first run (`hasInitialFitRef` guard). Later
  // runs just update `initialScale` (the minimap-visibility threshold).
  // biome-ignore lint/correctness/useExhaustiveDependencies: isFullscreen triggers re-fit when switching between inline and fullscreen
  useEffect(() => {
    if (!(svgDimensions && containerRef.current)) {
      return;
    }
    // rAF waits for layout — especially important right after fullscreen
    // toggles, when clientWidth/Height haven't yet reflected the new size.
    requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const { clientWidth, clientHeight } = container;
      if (clientWidth <= 0 || clientHeight <= 0) {
        return;
      }
      const fit = computeFitTransform(svgDimensions, clientWidth, clientHeight);
      setInitialScale(fit.scale);
      if (!hasInitialFitRef.current) {
        setTransform(fit);
        hasInitialFitRef.current = true;
      }
    });
  }, [svgDimensions, isFullscreen]);

  const zoomTo = useCallback(
    (newScale: number, cx?: number, cy?: number) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      setTransform(
        zoomAtPoint(
          transformRef.current,
          newScale,
          cx ?? rect.width / 2,
          cy ?? rect.height / 2
        )
      );
    },
    [transformRef]
  );

  const zoomIn = useCallback(
    () => zoomTo(transformRef.current.scale * (1 + ZOOM_FACTOR)),
    [transformRef, zoomTo]
  );
  const zoomOut = useCallback(
    () => zoomTo(transformRef.current.scale * (1 - ZOOM_FACTOR)),
    [transformRef, zoomTo]
  );

  const fitToView = useCallback(() => {
    const container = containerRef.current;
    if (!(svgDimensions && container)) {
      return;
    }
    const fit = computeFitTransform(
      svgDimensions,
      container.clientWidth,
      container.clientHeight
    );
    setTransform(fit);
    setInitialScale(fit.scale);
  }, [svgDimensions]);

  // Wheel zoom. Attached via `addEventListener` (not React's `onWheel`)
  // because we need `{ passive: false }` to call `preventDefault` and stop
  // the page from scrolling while zooming.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    function computeWheelFactor(e: WheelEvent): number {
      // Trackpad pinch → wheel + ctrlKey with fine-grained deltaY. Regular
      // wheel → discrete ticks in ZOOM_FACTOR increments.
      if (e.ctrlKey) {
        return 1 - e.deltaY * 0.01;
      }
      return e.deltaY > 0 ? 1 - ZOOM_FACTOR : 1 + ZOOM_FACTOR;
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      e.stopPropagation();
      const factor = computeWheelFactor(e);
      const rect = container!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const cur = transformRef.current;
      const newScale = Math.min(
        Math.max(cur.scale * factor, MIN_SCALE),
        MAX_SCALE
      );
      setTransform(zoomAtPoint(cur, newScale, cx, cy));
    }
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [transformRef]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Left button only — right-click should open the browser context menu.
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      isPanningRef.current = true;
      setCursorGrabbing(true);
      // Pre-compute "where was the pointer relative to the content's current
      // position", so each subsequent move can recompute the translation as
      // `clientPos - start` — no accumulation, no drift.
      panStartRef.current = {
        x: e.clientX - transformRef.current.x,
        y: e.clientY - transformRef.current.y,
      };
      // Capture so the drag continues even if the cursor exits the container.
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [transformRef]
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanningRef.current) {
      return;
    }
    setTransform((prev) => ({
      ...prev,
      x: e.clientX - panStartRef.current.x,
      y: e.clientY - panStartRef.current.y,
    }));
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanningRef.current = false;
    setCursorGrabbing(false);
  }, []);

  const handleDoubleClick = useCallback(() => fitToView(), [fitToView]);

  // Minimap click → center the main viewport on the clicked SVG coordinate
  // (preserving the current zoom level).
  const handleMinimapNavigate = useCallback(
    (svgX: number, svgY: number) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      setTransform(
        centerOnSvgPoint(
          transformRef.current,
          svgX,
          svgY,
          container.clientWidth,
          container.clientHeight
        )
      );
    },
    [transformRef]
  );

  const handleExportSvg = useCallback(() => {
    exportSvg(processedSvg, "mermaid-diagram.svg");
  }, [processedSvg]);

  const handleExportPng = useCallback(() => {
    if (!svgDimensions) {
      return;
    }
    exportPng(
      processedSvg,
      svgDimensions.width,
      svgDimensions.height,
      "mermaid-diagram.png"
    );
  }, [processedSvg, svgDimensions]);

  // Hide the minimap at or near fit-to-view — there's nothing to navigate to.
  // The 1.2x threshold means "the user has zoomed in at least 20% past fit".
  const showMinimap = svgDimensions && transform.scale > initialScale * 1.2;
  const containerHeight = isFullscreen ? "100%" : `${INLINE_HEIGHT}px`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pan/zoom canvas requires pointer event handlers
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: pan/zoom canvas
    <div
      className={`relative select-none overflow-hidden ${cursorGrabbing ? "cursor-grabbing" : "cursor-grab"} ${isFullscreen ? "h-full w-full" : ""}`}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={containerRef}
      // `touchAction: none` disables browser default gestures so our pointer
      // handlers own everything.
      style={{ height: containerHeight, touchAction: "none" }}
    >
      <div
        // `absolute top-0 left-0 origin-top-left` — anchor at the container's
        // top-left and declare scale-from-top-left. Makes the pan/zoom math
        // linear and easy to reason about.
        className="absolute top-0 left-0 origin-top-left"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid generates safe SVG
        dangerouslySetInnerHTML={{ __html: processedSvg }}
        ref={contentRef}
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          // Hint the compositor — smoother pan/zoom on large diagrams.
          willChange: "transform",
        }}
      />

      {/* Decorative "mermaid" badge. Stops pointer events so it doesn't
          initiate a pan. */}
      <div
        className="absolute top-3 left-3 z-20 select-none rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur-sm"
        onPointerDown={(e) => e.stopPropagation()}
      >
        mermaid
      </div>

      <ViewerToolbar
        isFullscreen={!!isFullscreen}
        onEdit={onEdit}
        onExportPng={handleExportPng}
        onExportSvg={handleExportSvg}
        onFitToView={fitToView}
        onToggleFullscreen={onToggleFullscreen}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        scale={transform.scale}
      />

      {/* The minimap depends on three independent measurements: the parsed
          viewBox dims, the container's rendered size, and the live visible
          region. Falls back to viewBox dims when the DOM-measured values
          aren't available yet. */}
      {svgDimensions && containerSize.width > 0 && visibleRegion && (
        <Minimap
          contentNaturalHeight={
            contentBBox?.height ?? naturalSize?.height ?? svgDimensions.height
          }
          contentNaturalWidth={
            contentBBox?.width ?? naturalSize?.width ?? svgDimensions.width
          }
          onNavigate={handleMinimapNavigate}
          originX={contentBBox?.x ?? 0}
          originY={contentBBox?.y ?? 0}
          svgDataUri={minimapDataUri}
          visible={!!showMinimap}
          visibleHeightSvg={visibleRegion.height}
          visibleLeftSvg={visibleRegion.x}
          visibleTopSvg={visibleRegion.y}
          visibleWidthSvg={visibleRegion.width}
        />
      )}
    </div>
  );
}

/**
 * A single icon button in the floating toolbar with a Radix tooltip. Purely
 * presentational.
 */
function ToolbarButton({
  label,
  onClick,
  children,
}: Readonly<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClick}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Floating toolbar in the top-right corner of the viewport: zoom %, zoom
 * in/out, fit-to-view, fullscreen, download menu, and (optionally) an edit-
 * source button.
 *
 * The root `onPointerDown` is stopped so that clicks on toolbar buttons don't
 * also initiate a pan gesture on the underlying canvas.
 */
function ViewerToolbar({
  scale,
  isFullscreen,
  onZoomIn,
  onZoomOut,
  onFitToView,
  onToggleFullscreen,
  onEdit,
  onExportSvg,
  onExportPng,
}: Readonly<{
  scale: number;
  isFullscreen: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToView: () => void;
  onToggleFullscreen: () => void;
  onEdit?: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
}>) {
  const zoomPercent = Math.round(scale * 100);

  return (
    <div
      className="absolute top-3 right-3 z-20 flex items-center gap-0.5 rounded-lg border border-border/40 bg-background/80 px-1.5 py-1 shadow-md backdrop-blur-sm"
      // Prevent the pan gesture from starting when a toolbar button is clicked.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TooltipProvider delayDuration={300}>
        <ToolbarButton label="Zoom out" onClick={onZoomOut}>
          <Minus className="size-3.5" />
        </ToolbarButton>

        <span className="min-w-[3rem] select-none text-center font-mono text-[11px] text-muted-foreground">
          {zoomPercent}%
        </span>

        <ToolbarButton label="Zoom in" onClick={onZoomIn}>
          <Plus className="size-3.5" />
        </ToolbarButton>

        <div className="mx-0.5 h-4 w-px bg-border/50" />

        <ToolbarButton label="Fit to view" onClick={onFitToView}>
          <RotateCcw className="size-3.5" />
        </ToolbarButton>

        <ToolbarButton
          label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </ToolbarButton>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  type="button"
                >
                  <Download className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Download</p>
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onExportPng}>
              Download as PNG
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExportSvg}>
              Download as SVG
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {onEdit && (
          <>
            <div className="mx-0.5 h-4 w-px bg-border/50" />
            <ToolbarButton label="Edit source" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </ToolbarButton>
          </>
        )}
      </TooltipProvider>
    </div>
  );
}

/** Minimap footprint in CSS pixels — tuned so clusters stay distinguishable. */
const MINIMAP_MAX_WIDTH = 300;
const MINIMAP_MAX_HEIGHT = 200;

/**
 * Bottom-right minimap: a scaled-down thumbnail of the diagram with a
 * rectangle showing the currently-visible region. Clicking navigates the main
 * viewport to center on that point.
 *
 * `originX`/`originY` are the viewBox origin of the thumbnail's (possibly
 * cropped) SVG. We subtract them when positioning the viewport rectangle so
 * thumbnail coords and rectangle coords share an origin.
 *
 * IMPORTANT: the `<img>` has `style={{ margin: 0 }}` to defeat the editor's
 * typography/prose CSS that would otherwise push the img down ~32px inside
 * the button. Inline styles override the `.prose img { margin: X }`
 * selector's specificity.
 */
function Minimap({
  svgDataUri,
  contentNaturalWidth,
  contentNaturalHeight,
  originX,
  originY,
  visibleLeftSvg,
  visibleTopSvg,
  visibleWidthSvg,
  visibleHeightSvg,
  visible,
  onNavigate,
}: Readonly<{
  svgDataUri: string;
  contentNaturalWidth: number;
  contentNaturalHeight: number;
  originX: number;
  originY: number;
  visibleLeftSvg: number;
  visibleTopSvg: number;
  visibleWidthSvg: number;
  visibleHeightSvg: number;
  visible: boolean;
  onNavigate: (svgX: number, svgY: number) => void;
}>) {
  // Single uniform scale factor — preserves aspect ratio.
  const minimapScale = Math.min(
    MINIMAP_MAX_WIDTH / contentNaturalWidth,
    MINIMAP_MAX_HEIGHT / contentNaturalHeight
  );
  const contentW = contentNaturalWidth * minimapScale;
  const contentH = contentNaturalHeight * minimapScale;

  // Viewport rectangle in minimap-local CSS pixels. The `- origin*` terms
  // translate from uncropped SVG coords into the cropped thumbnail's own
  // coords (where (originX, originY) maps to (0, 0)).
  const vpLeft = (visibleLeftSvg - originX) * minimapScale;
  const vpTop = (visibleTopSvg - originY) * minimapScale;
  const vpWidth = visibleWidthSvg * minimapScale;
  const vpHeight = visibleHeightSvg * minimapScale;

  function handleClick(e: React.MouseEvent) {
    // Reverse of the viewport math: click point in minimap pixels → SVG coords.
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = originX + (e.clientX - rect.left) / minimapScale;
    const svgY = originY + (e.clientY - rect.top) / minimapScale;
    onNavigate(svgX, svgY);
  }

  return (
    <button
      className={`absolute right-3 bottom-3 z-20 cursor-crosshair overflow-hidden rounded-md border-0 bg-background/80 p-0 shadow-md ring-1 ring-border/40 backdrop-blur-sm transition-opacity duration-200 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`}
      onClick={handleClick}
      style={{ width: contentW, height: contentH }}
      type="button"
    >
      {/* biome-ignore lint/performance/noImgElement: data URI minimap, next/image not applicable */}
      {/* biome-ignore lint/correctness/useImageSize: dimensions set via style for dynamic sizing */}
      <img
        alt=""
        className="block opacity-60"
        draggable={false}
        src={svgDataUri}
        // `margin: 0` is required — the editor's `.prose img` rule otherwise
        // pushes this img ~32px down inside its button, making the viewport
        // rectangle appear to float above the thumbnail content.
        style={{ width: contentW, height: contentH, margin: 0 }}
      />
      <div
        className="absolute rounded-[2px] border-[1.5px] border-primary/60 bg-primary/10"
        style={{
          left: vpLeft,
          top: vpTop,
          width: vpWidth,
          height: vpHeight,
        }}
      />
    </button>
  );
}
