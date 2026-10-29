import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanStatusCode as OTelSpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  SimpleSpanProcessor,
  WebTracerProvider,
} from "@opentelemetry/sdk-trace-web";
import { sanitizeDesktopException } from "../shared/exception-sanitizer";
import { exponentialBackoffMs } from "../shared/exponential-backoff";
import {
  buildRenderCommitBridgeRecord,
  type RenderCommitEvent,
  RendererRenderPhase,
} from "../shared/render-commit-event";
import {
  DesktopOtelSignal,
  RENDERER_RENDER_COMMIT_SAMPLE_RATE,
  type RendererOtelBridgePayload,
  type RendererOtelBridgeRecord,
  type RendererOtelExceptionAttributes,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../shared/renderer-otel-bridge-constants";
import {
  hrTimeToUnixNanoString,
  isTerminalRendererOtelResult,
  normalizeAttributes,
  normalizeInstrumentationScope,
  normalizeSpanKind,
  normalizeSpanStatus,
} from "../shared/renderer-otel-bridge-utils";

export type RendererOtelRuntime = {
  start: () => Promise<void>;
  reportException: (input: RendererExceptionReportInput) => void;
  reportRenderCommit: (input: RenderCommitEvent) => void;
  shutdown: () => Promise<void>;
};

export type RendererExceptionReportInput = {
  error: unknown;
  componentStack?: string;
};

export type CreateRendererOtelRuntimeOptions = {
  exportTelemetry?: (
    payload: RendererOtelBridgePayload
  ) => Promise<RendererOtelExportResult>;
  /** Head sampler for non-`mount` render commits (seam for deterministic
   * tests). Returns true to keep. Defaults to a `RENDERER_RENDER_COMMIT_SAMPLE_RATE`
   * Bernoulli draw. */
  renderCommitSampler?: () => boolean;
};

const RENDERER_BOOTSTRAP_RECORD: RendererOtelBridgeRecord = {
  signal: DesktopOtelSignal.Trace,
  instrumentationScope: { name: "closedloop-desktop-renderer" },
  name: "desktop.renderer.otel.bootstrap",
};
const RENDERER_TRACER_NAME = "closedloop-desktop-renderer";
const RENDERER_EXCEPTION_SPAN_NAME = "exception";

/**
 * ISS-6329 — bounded re-offer ladder for exceptions raised before the main OTel
 * runtime finished booting. Six scheduled retries on the shared backoff
 * schedule span ~11.75s past the immediate first attempt, which comfortably
 * covers a real main-process boot; past that the queue is dropped, so a runtime
 * that never starts costs a fixed handful of IPC calls rather than a timer that
 * outlives the window. The queue cap bounds a renderer throwing in a loop while
 * main is still coming up.
 */
export const PENDING_EXCEPTION_QUEUE_LIMIT = 8;
export const PENDING_EXCEPTION_MAX_RETRIES = 6;
const PENDING_EXCEPTION_RETRY_BASE_MS = 250;
const PENDING_EXCEPTION_RETRY_MAX_MS = 4000;

export function createRendererOtelRuntime({
  exportTelemetry,
  renderCommitSampler,
}: CreateRendererOtelRuntimeOptions): RendererOtelRuntime {
  let provider: WebTracerProvider | null = null;
  let startPromise: Promise<void> | null = null;
  let terminalNoop = false;
  let started = false;
  const pendingExceptions: RendererOtelBridgeRecord[] = [];
  let pendingExceptionRetries = 0;
  let pendingExceptionLadderSpent = false;
  let pendingExceptionDrainActive = false;
  let pendingExceptionTimer: ReturnType<typeof setTimeout> | null = null;
  const shouldKeepRenderCommit =
    renderCommitSampler ??
    (() => Math.random() < RENDERER_RENDER_COMMIT_SAMPLE_RATE);

  return {
    start() {
      return ensureStarted();
    },
    reportException(input) {
      if (!exportTelemetry || terminalNoop) {
        return;
      }
      if (!started) {
        queuePendingException({
          signal: DesktopOtelSignal.Log,
          name: RENDERER_EXCEPTION_SPAN_NAME,
          attributes: rendererExceptionAttributes(input),
        });
        startPendingExceptionDrain();
        return;
      }
      withStartedRendererRuntime(() => {
        const span = trace
          .getTracer(RENDERER_TRACER_NAME)
          .startSpan(RENDERER_EXCEPTION_SPAN_NAME, {
            attributes: rendererExceptionAttributes(input),
          });
        span.setStatus({ code: OTelSpanStatusCode.ERROR });
        span.end();
      });
    },
    reportRenderCommit(input) {
      if (!exportTelemetry || terminalNoop) {
        return;
      }
      // Head-sample before building a record: `mount` is always kept (rare +
      // most diagnostic), every other phase is sampled. Sampling here keeps the
      // bridge's 8-batches/s rate limit well clear of being the throttle.
      if (
        input.phase !== RendererRenderPhase.Mount &&
        !shouldKeepRenderCommit()
      ) {
        return;
      }
      withStartedRendererRuntime(() => {
        const record = buildRenderCommitBridgeRecord(input);
        trace
          .getTracer(RENDERER_TRACER_NAME)
          .startSpan(record.name ?? "", { attributes: record.attributes })
          .end();
      });
    },
    async shutdown() {
      terminalNoop = true;
      clearPendingExceptionRetry();
      pendingExceptions.length = 0;
      pendingExceptionRetries = 0;
      pendingExceptionLadderSpent = false;
      if (startPromise) {
        await startPromise;
      }
      if (provider) {
        await provider.shutdown();
      }
      provider = null;
      started = false;
    },
  };

  async function startRendererRuntime(
    bridgeExport: NonNullable<
      CreateRendererOtelRuntimeOptions["exportTelemetry"]
    >
  ): Promise<void> {
    const probeResult = await bridgeExport({
      records: [RENDERER_BOOTSTRAP_RECORD],
    });
    if (!probeResult.ok) {
      if (isTerminalRendererOtelResult(probeResult)) {
        latchTerminalNoop();
      }
      return;
    }

    const exporter = new RendererOtelSpanExporter(
      bridgeExport,
      () => terminalNoop,
      latchTerminalNoop
    );
    provider = new WebTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    started = true;
  }

  function ensureStarted(): Promise<void> {
    if (terminalNoop || started) {
      return Promise.resolve();
    }
    if (!exportTelemetry) {
      latchTerminalNoop();
      return Promise.resolve();
    }
    if (!startPromise) {
      startPromise = startRendererRuntime(exportTelemetry)
        .catch(() => {
          latchTerminalNoop();
        })
        .finally(() => {
          startPromise = null;
        });
    }
    return startPromise;
  }

  function queuePendingException(record: RendererOtelBridgeRecord): void {
    // Overflow drops the newest: the first exceptions of a window are the ones
    // that explain the rest. Once the ladder is spent nothing is queued at all,
    // so a runtime that never starts costs a fixed number of IPC calls for the
    // window rather than one more per exception, forever.
    if (
      !pendingExceptionLadderSpent &&
      pendingExceptions.length < PENDING_EXCEPTION_QUEUE_LIMIT
    ) {
      pendingExceptions.push(record);
    }
  }

  function clearPendingExceptionRetry(): void {
    if (pendingExceptionTimer !== null) {
      clearTimeout(pendingExceptionTimer);
      pendingExceptionTimer = null;
    }
  }

  function schedulePendingExceptionRetry(): void {
    if (terminalNoop) {
      pendingExceptions.length = 0;
      return;
    }
    if (pendingExceptionTimer !== null || pendingExceptions.length === 0) {
      return;
    }
    if (pendingExceptionRetries >= PENDING_EXCEPTION_MAX_RETRIES) {
      // Give up on BUFFERING only. `terminalNoop` stays false, so the probe and
      // span paths keep re-offering and still recover if main comes up late —
      // this is a bounded queue, not the latch ISS-6329 removes.
      pendingExceptionLadderSpent = true;
      pendingExceptions.length = 0;
      return;
    }
    pendingExceptionRetries += 1;
    const delayMs = exponentialBackoffMs(
      pendingExceptionRetries,
      PENDING_EXCEPTION_RETRY_BASE_MS,
      PENDING_EXCEPTION_RETRY_MAX_MS
    );
    pendingExceptionTimer = setTimeout(() => {
      // Released as the timer FIRES, so a cancelled or completed timer can
      // never suppress the next scheduling attempt.
      pendingExceptionTimer = null;
      startPendingExceptionDrain();
    }, delayMs);
  }

  function startPendingExceptionDrain(): void {
    drainPendingExceptions().catch(latchTerminalNoop);
  }

  /**
   * The ONLY way `terminalNoop` is set outside shutdown. Latching means no
   * later export in this window can succeed, so the pre-start queue and its
   * armed timer are dead weight the moment it happens — clearing them here is
   * what stops a superseded timer firing into a drain that can never send.
   */
  function latchTerminalNoop(): void {
    terminalNoop = true;
    clearPendingExceptionRetry();
    pendingExceptions.length = 0;
  }

  /**
   * ONE record per export, never a merged batch. The main-side parser rejects
   * the WHOLE payload over `RENDERER_OTEL_MAX_BATCH_BYTES` and fails a batch on
   * its first unparseable record, so merging the queue would let one oversized
   * or malformed exception take every other queued exception down with it —
   * the exact loss this ticket exists to stop, one layer further in.
   *
   * Single-flight, because the record in flight is still at the head of the
   * queue: concurrent drains would send it twice.
   */
  async function drainPendingExceptions(): Promise<void> {
    if (pendingExceptionDrainActive || !exportTelemetry) {
      return;
    }
    pendingExceptionDrainActive = true;
    try {
      while (!terminalNoop && pendingExceptions.length > 0) {
        const result = await exportTelemetry({
          records: [pendingExceptions[0]],
        }).catch(() => null);
        if (!consumePendingExceptionResult(result)) {
          return;
        }
      }
      pendingExceptionRetries = 0;
      // A drained queue is the one unambiguous "main is up now" signal the
      // renderer gets. Without this the tracer provider stays unstarted after a
      // boot race until some render commit happens to re-drive the probe.
      ensureStarted().catch(latchTerminalNoop);
    } finally {
      pendingExceptionDrainActive = false;
    }
  }

  /** True to keep draining; false to stop (retry scheduled, or terminal). */
  function consumePendingExceptionResult(
    result: RendererOtelExportResult | null
  ): boolean {
    // A throwing bridge means no IPC handler is listening at all — terminal,
    // exactly as it was before ISS-6329.
    if (result === null || isTerminalRendererOtelResult(result)) {
      latchTerminalNoop();
      return false;
    }
    // A record the bridge cannot parse will never parse, so re-offering it
    // would burn the whole ladder and strand every exception behind it.
    if (
      result.ok ||
      result.reason === RendererOtelExportFailureReason.InvalidPayload
    ) {
      pendingExceptions.shift();
      return true;
    }
    schedulePendingExceptionRetry();
    return false;
  }

  function withStartedRendererRuntime(callback: () => void): void {
    if (started) {
      callback();
      return;
    }
    ensureStarted()
      .then(() => {
        if (started && !terminalNoop) {
          callback();
        }
      })
      .catch(latchTerminalNoop);
  }
}

function rendererExceptionAttributes(
  input: RendererExceptionReportInput
): RendererOtelExceptionAttributes {
  const attributes = sanitizeDesktopException({
    error: input.error,
    origin: AppExceptionOrigin.Renderer,
    componentStack: input.componentStack,
  });

  return {
    [TelemetryAttribute.ExceptionType]:
      attributes[TelemetryAttribute.ExceptionType],
    [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
    ...(attributes[TelemetryAttribute.ExceptionMessage]
      ? {
          [TelemetryAttribute.ExceptionMessage]:
            attributes[TelemetryAttribute.ExceptionMessage],
        }
      : {}),
    ...(attributes[TelemetryAttribute.ExceptionStacktrace]
      ? {
          [TelemetryAttribute.ExceptionStacktrace]:
            attributes[TelemetryAttribute.ExceptionStacktrace],
        }
      : {}),
  };
}

class RendererOtelSpanExporter implements SpanExporter {
  private readonly exportTelemetry: NonNullable<
    CreateRendererOtelRuntimeOptions["exportTelemetry"]
  >;
  private readonly shouldSkipExport: () => boolean;
  private readonly markTerminalNoop: () => void;

  constructor(
    exportTelemetry: NonNullable<
      CreateRendererOtelRuntimeOptions["exportTelemetry"]
    >,
    shouldSkipExport: () => boolean,
    markTerminalNoop: () => void
  ) {
    this.exportTelemetry = exportTelemetry;
    this.shouldSkipExport = shouldSkipExport;
    this.markTerminalNoop = markTerminalNoop;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter["export"]>[1]
  ): void {
    if (this.shouldSkipExport()) {
      resultCallback({ code: 0 });
      return;
    }

    this.exportTelemetry({
      records: spans.map(spanToBridgeRecord),
    })
      .then((result) => {
        if (isTerminalRendererOtelResult(result)) {
          this.markTerminalNoop();
        }
        resultCallback({ code: result.ok ? 0 : 1 });
      })
      .catch(() => {
        this.markTerminalNoop();
        resultCallback({ code: 1 });
      });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

function spanToBridgeRecord(span: ReadableSpan): RendererOtelBridgeRecord {
  const spanContext = span.spanContext();
  return {
    signal: DesktopOtelSignal.Trace,
    instrumentationScope: normalizeInstrumentationScope(
      span.instrumentationScope
    ),
    timestampUnixNano: hrTimeToUnixNanoString(span.endTime),
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    ...(span.parentSpanContext
      ? { parentSpanId: span.parentSpanContext.spanId }
      : {}),
    kind: normalizeSpanKind(span.kind),
    status: normalizeSpanStatus(span.status),
    name: span.name,
    attributes: normalizeAttributes(span.attributes),
    ...(span.droppedAttributesCount === 0
      ? {}
      : { droppedAttributesCount: span.droppedAttributesCount }),
    ...(span.droppedEventsCount === 0
      ? {}
      : { droppedEventsCount: span.droppedEventsCount }),
    ...(span.droppedLinksCount === 0
      ? {}
      : { droppedLinksCount: span.droppedLinksCount }),
  };
}
