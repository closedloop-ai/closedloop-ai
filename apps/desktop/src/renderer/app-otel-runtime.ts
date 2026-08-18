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

export function createRendererOtelRuntime({
  exportTelemetry,
  renderCommitSampler,
}: CreateRendererOtelRuntimeOptions): RendererOtelRuntime {
  let provider: WebTracerProvider | null = null;
  let startPromise: Promise<void> | null = null;
  let terminalNoop = false;
  let started = false;
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
        exportTelemetry({
          records: [
            {
              signal: DesktopOtelSignal.Log,
              name: RENDERER_EXCEPTION_SPAN_NAME,
              attributes: rendererExceptionAttributes(input),
            },
          ],
        })
          .then((result) => {
            if (isTerminalRendererOtelResult(result)) {
              terminalNoop = true;
            }
          })
          .catch(() => {
            terminalNoop = true;
          });
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
        terminalNoop = true;
      }
      return;
    }

    const exporter = new RendererOtelSpanExporter(
      bridgeExport,
      () => terminalNoop,
      () => {
        terminalNoop = true;
      }
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
      terminalNoop = true;
      return Promise.resolve();
    }
    if (!startPromise) {
      startPromise = startRendererRuntime(exportTelemetry)
        .catch(() => {
          terminalNoop = true;
        })
        .finally(() => {
          startPromise = null;
        });
    }
    return startPromise;
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
      .catch(() => {
        terminalNoop = true;
      });
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
