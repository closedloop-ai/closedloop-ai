import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  SimpleSpanProcessor,
  WebTracerProvider,
} from "@opentelemetry/sdk-trace-web";
import { sanitizeDesktopException } from "../shared/exception-sanitizer";
import {
  DesktopOtelSignal,
  type RendererOtelBridgePayload,
  type RendererOtelBridgeRecord,
  type RendererOtelExportResult,
} from "../shared/renderer-otel-bridge-constants";
import {
  hrTimeToUnixNanoString,
  isTerminalRendererOtelResult,
  normalizeAttributes,
  normalizeInstrumentationScope,
} from "../shared/renderer-otel-bridge-utils";

export type RendererOtelRuntime = {
  start: () => Promise<void>;
  reportException: (input: RendererExceptionReportInput) => void;
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
};

const RENDERER_BOOTSTRAP_RECORD: RendererOtelBridgeRecord = {
  signal: DesktopOtelSignal.Trace,
  instrumentationScope: { name: "closedloop-desktop-renderer" },
  name: "desktop.renderer.otel.bootstrap",
};

export function createRendererOtelRuntime({
  exportTelemetry,
}: CreateRendererOtelRuntimeOptions): RendererOtelRuntime {
  let provider: WebTracerProvider | null = null;
  let startPromise: Promise<void> | null = null;
  let terminalNoop = false;
  let started = false;

  return {
    start() {
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
    },
    reportException(input) {
      if (!exportTelemetry || terminalNoop) {
        return;
      }
      const record = rendererExceptionToBridgeRecord(input);
      exportTelemetry({ records: [record] })
        .then((result) => {
          if (isTerminalRendererOtelResult(result)) {
            terminalNoop = true;
          }
        })
        .catch(() => {
          terminalNoop = true;
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
}

function rendererExceptionToBridgeRecord(
  input: RendererExceptionReportInput
): RendererOtelBridgeRecord {
  const attributes = sanitizeDesktopException({
    error: input.error,
    origin: AppExceptionOrigin.Renderer,
    componentStack: input.componentStack,
  });

  return {
    signal: DesktopOtelSignal.Log,
    name: "exception",
    attributes: {
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
    },
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
  return {
    signal: DesktopOtelSignal.Trace,
    instrumentationScope: normalizeInstrumentationScope(
      span.instrumentationScope
    ),
    timestampUnixNano: hrTimeToUnixNanoString(span.endTime),
    name: span.name,
    attributes: normalizeAttributes(span.attributes),
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}
