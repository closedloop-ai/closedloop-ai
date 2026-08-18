import {
  defaultProfilingClock,
  type ProfilingClock,
  type ProfilingRenderCommitRow,
  type ProfilingSink,
} from "../../shared/profiling.js";
import { RENDERER_RENDER_COMMIT_EVENT_NAME_BASE } from "../../shared/render-commit-event.js";
import {
  parseRendererOtelBridgePayload,
  type RendererOtelBridgeParseResult,
} from "../../shared/renderer-otel-bridge.js";
import {
  RENDERER_OTEL_RATE_LIMIT_MAX_BATCHES,
  RENDERER_OTEL_RATE_LIMIT_WINDOW_MS,
  RendererOtelAllowedAttributeKey,
  type RendererOtelBridgeRecord,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
  type RendererOtelGenericBridgeRecord,
} from "../../shared/renderer-otel-bridge-constants.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";

/**
 * A render-commit event name is always the base plus a `.` and the view suffix
 * (`renderCommitEventName`), never the bare base — so this filter is a PREFIX
 * match. An equality check against the base would capture zero records.
 */
const RENDER_COMMIT_NAME_PREFIX = `${RENDERER_RENDER_COMMIT_EVENT_NAME_BASE}.`;

export type RendererOtelExportDeps = {
  isTrustedSender: (sender: unknown) => boolean;
  runtime: DesktopOtelRuntime;
  now?: () => number;
  parsePayload?: (payload: unknown) => RendererOtelBridgeParseResult;
  /**
   * ISS-4430 — optional profiling tap. Present only while
   * `CLOSEDLOOP_PROFILE_DIR` is set; absent (the production default) leaves this
   * handler's behavior byte-identical. The OTel export is NEVER conditional on
   * it: see {@link recordRenderCommits}.
   */
  profilingSink?: ProfilingSink<ProfilingRenderCommitRow>;
  profilingClock?: ProfilingClock;
};

type RendererOtelExportEvent = { sender: unknown };

export function createRendererOtelExportHandler(deps: RendererOtelExportDeps) {
  const now = deps.now ?? Date.now;
  const parsePayload = deps.parsePayload ?? parseRendererOtelBridgePayload;
  const rateLimit = createRendererOtelRateLimit(now);

  return (
    event: RendererOtelExportEvent,
    payload: unknown
  ): RendererOtelExportResult => {
    if (!deps.isTrustedSender(event.sender)) {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.UntrustedSender,
      };
    }

    if (!rateLimit.tryEnter()) {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.RateLimited,
      };
    }

    try {
      const parsed = parsePayload(payload);
      if (!parsed.ok) {
        return parsed.result;
      }
      // ISS-4430: the sink tap swallows its own failures internally, so a
      // throwing sink can never reach the catch below and turn a healthy export
      // into an ExportFailed result.
      recordRenderCommits(deps, parsed.payload.records);
      return deps.runtime.exportExternalRecords(parsed.payload.records);
    } catch {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.ExportFailed,
      };
    }
  };
}

function createRendererOtelRateLimit(now: () => number) {
  let windowStartedAt = 0;
  let acceptedInWindow = 0;

  return {
    // The IPC export handler is synchronous and Electron processes each
    // ipcMain message as a separate event-loop task, so there is never more
    // than one export in flight; a window-based cap is the only meaningful
    // rate limit here.
    tryEnter() {
      const currentTime = now();
      if (currentTime - windowStartedAt >= RENDERER_OTEL_RATE_LIMIT_WINDOW_MS) {
        windowStartedAt = currentTime;
        acceptedInWindow = 0;
      }
      if (acceptedInWindow >= RENDERER_OTEL_RATE_LIMIT_MAX_BATCHES) {
        return false;
      }
      acceptedInWindow += 1;
      return true;
    },
  };
}

/** A bridge record whose event name identifies it as a render commit. */
type RenderCommitBridgeRecord = RendererOtelGenericBridgeRecord & {
  name: string;
};

/** Stand-in for a label the renderer did not send. Never a fabricated value. */
const UNKNOWN_RENDER_COMMIT_LABEL = "unknown";

/**
 * ISS-4430 — tap render-commit records onto the profiling sink.
 *
 * The renderer can only cross the sanitizing bridge with four generic
 * `renderer.*` envelope keys, so a commit arrives as a positional tuple rather
 * than named fields. Decoding happens HERE, at write time, so the generic JSONL
 * analyzer downstream reads uniform flat rows and never has to know the
 * envelope contract.
 *
 * Wholly self-contained failure handling: the caller invokes this BEFORE
 * `exportExternalRecords` inside the handler's existing try, so anything that
 * escaped here would be caught by the export failure boundary and would silently
 * turn a healthy export into an ExportFailed result. It therefore swallows
 * everything itself. Returns immediately when no sink is injected, which is the
 * production default.
 */
function recordRenderCommits(
  deps: RendererOtelExportDeps,
  records: RendererOtelBridgeRecord[]
): void {
  const sink = deps.profilingSink;
  if (!sink) {
    return;
  }
  try {
    const clock = deps.profilingClock ?? defaultProfilingClock;
    const ts = clock.nowEpochMs();
    for (const record of records) {
      if (!isRenderCommitRecord(record)) {
        continue;
      }
      const row = decodeRenderCommitRow(record, ts);
      if (row) {
        sink.append(row);
      }
    }
  } catch {
    // Fail-open: instrumentation never affects the instrumented operation.
  }
}

function isRenderCommitRecord(
  record: RendererOtelBridgeRecord
): record is RenderCommitBridgeRecord {
  return (
    typeof record.name === "string" &&
    record.name.startsWith(RENDER_COMMIT_NAME_PREFIX)
  );
}

/**
 * `null` when the commit carries no usable duration. A row is only worth writing
 * if its measurement decoded — emitting a `0` for an absent value would put a
 * number in the report that no commit ever produced.
 */
function decodeRenderCommitRow(
  record: RenderCommitBridgeRecord,
  ts: number
): ProfilingRenderCommitRow | null {
  const actualMs = readRenderCommitActualMs(record.attributes);
  if (actualMs === null) {
    return null;
  }
  return {
    // The view lives in the event NAME (attribute VALUES are scrubbed by the
    // bridge sanitizer, which rejects the substring "session"), so it is read
    // back off the suffix.
    view: record.name.slice(RENDER_COMMIT_NAME_PREFIX.length),
    phase: readRenderCommitLabel(
      record.attributes,
      RendererOtelAllowedAttributeKey.Status
    ),
    cause: readRenderCommitLabel(
      record.attributes,
      RendererOtelAllowedAttributeKey.Mode
    ),
    actualMs,
    ts,
  };
}

function readRenderCommitActualMs(
  attributes: RendererOtelGenericBridgeRecord["attributes"]
): number | null {
  const values = attributes?.[RendererOtelAllowedAttributeKey.Values];
  if (!Array.isArray(values)) {
    return null;
  }
  // Positional tuple contract (`buildRenderCommitBridgeRecord`): index 0 is
  // actual_ms, index 1 is base_ms.
  const actualMs = values[0];
  if (typeof actualMs !== "number" || !Number.isFinite(actualMs)) {
    return null;
  }
  return actualMs;
}

function readRenderCommitLabel(
  attributes: RendererOtelGenericBridgeRecord["attributes"],
  key: RendererOtelAllowedAttributeKey
): string {
  const value = attributes?.[key];
  return typeof value === "string" ? value : UNKNOWN_RENDER_COMMIT_LABEL;
}
