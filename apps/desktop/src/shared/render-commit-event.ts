import {
  DesktopOtelSignal,
  RendererOtelAllowedAttributeKey,
  type RendererOtelGenericBridgeRecord,
} from "./renderer-otel-bridge-constants.js";

// FEA-1998 — renderer render-commit timing wide events.
//
// React `<Profiler onRender>` measures how long a committed subtree took to
// render. We forward each (sampled) commit on the sessions list/detail views as
// a single OTel wide event so renderer cost is separable from DB/IPC cost
// (FEA-1997) and PGlite cost (FEA-1999).
//
// The renderer can only cross the sanitizing bridge with the four generic
// `renderer.*` envelope keys (see `renderer-otel-bridge-constants.ts`); any
// other attribute key null-drops the whole batch. So the render-commit fields
// are mapped onto that envelope here, in one pure place, and a unit test
// round-trips the result through the real `parseRendererOtelBridgePayload` to
// prove the sanitizer accepts it. The main process maps `renderer.*` onto
// canonical contract attributes once renderer egress lands (a tracked
// follow-up); until then these events terminate in the main-process buffer,
// exactly like the renderer telemetry shipped by FEA-1984.

/** Base OTel event name for a render commit; the view is appended as a stable
 * suffix (see `renderCommitEventName`). The view lives in the event NAME, not an
 * attribute value, on purpose: attribute values are scrubbed by the renderer
 * bridge's `isSafeString`, which rejects the substring "session" (a sensitive
 * key) and would null-drop the whole batch. Event/identifier fields are not
 * value-scrubbed, so the descriptive `sessions_list`/`sessions_detail` survives
 * there. (Proven by the sanitizer round-trip test.) */
export const RENDERER_RENDER_COMMIT_EVENT_NAME_BASE =
  "desktop.renderer.render_commit";

/** Stable, low-cardinality event name for a render commit on `view` (one of
 * exactly two values). */
export function renderCommitEventName(view: RendererRenderView): string {
  return `${RENDERER_RENDER_COMMIT_EVENT_NAME_BASE}.${view}`;
}

/** Which instrumented view produced the commit. */
export const RendererRenderView = {
  SessionsList: "sessions_list",
  SessionsDetail: "sessions_detail",
} as const;

export type RendererRenderView =
  (typeof RendererRenderView)[keyof typeof RendererRenderView];

/** React Profiler commit phase. */
export const RendererRenderPhase = {
  Mount: "mount",
  Update: "update",
  NestedUpdate: "nested-update",
} as const;

export type RendererRenderPhase =
  (typeof RendererRenderPhase)[keyof typeof RendererRenderPhase];

/** What interaction caused the commit. Best-effort, derived from which tracked
 * view input changed since the previous commit. */
export const RendererRenderCause = {
  Mount: "mount",
  Paginate: "paginate",
  Search: "search",
  Filter: "filter",
  Sort: "sort",
  DateRange: "date_range",
  Refresh: "refresh",
  Rerender: "rerender",
} as const;

export type RendererRenderCause =
  (typeof RendererRenderCause)[keyof typeof RendererRenderCause];

export type RenderCommitEvent = {
  view: RendererRenderView;
  phase: RendererRenderPhase;
  cause: RendererRenderCause;
  itemCount: number;
  actualMs: number;
  baseMs: number;
};

/** Round to 0.1 ms; coerce NaN/±Infinity/negative to 0 (keeps the payload tiny
 * and the value sane for an array attribute). */
export function round1(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value * 10) / 10;
}

/** Coerce to a non-negative integer count; non-finite → 0. */
export function clampCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}

/**
 * Map a render-commit measurement onto a single `Log`-signal bridge record. The
 * view is the event-name suffix; the four permitted `renderer.*` envelope keys
 * carry the rest:
 * - `renderer.values` = `[actual_ms, base_ms]`
 * - `renderer.count`  = item count
 * - `renderer.mode`   = interaction cause
 * - `renderer.status` = Profiler phase
 */
export function buildRenderCommitBridgeRecord(
  event: RenderCommitEvent
): RendererOtelGenericBridgeRecord {
  return {
    signal: DesktopOtelSignal.Log,
    instrumentationScope: { name: "closedloop-desktop-renderer" },
    name: renderCommitEventName(event.view),
    attributes: {
      // Positional tuple: index 0 = actual_ms, index 1 = base_ms. The main-side
      // envelope→contract mapping (deferred D3) decodes by position, so this
      // order is a contract — do not reorder or insert without updating D3.
      [RendererOtelAllowedAttributeKey.Values]: [
        round1(event.actualMs),
        round1(event.baseMs),
      ],
      [RendererOtelAllowedAttributeKey.Count]: clampCount(event.itemCount),
      [RendererOtelAllowedAttributeKey.Mode]: event.cause,
      [RendererOtelAllowedAttributeKey.Status]: event.phase,
    },
  };
}
