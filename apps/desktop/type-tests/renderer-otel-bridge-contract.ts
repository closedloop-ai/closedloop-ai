import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  DesktopOtelSignal,
  type RendererOtelBridgePayload,
} from "../src/shared/renderer-otel-bridge-constants.js";

export const validRendererPayload: RendererOtelBridgePayload = {
  records: [
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.span",
      value: ["ready", "active"],
    },
  ],
};

export const validRendererExceptionPayload: RendererOtelBridgePayload = {
  records: [
    {
      signal: DesktopOtelSignal.Log,
      name: "exception",
      attributes: {
        [TelemetryAttribute.ExceptionType]: "Error",
        [TelemetryAttribute.ExceptionMessage]: "Unexpected renderer error",
        [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
      },
    },
  ],
};

export const bodyIsRejectedAtRendererDtoBoundary: RendererOtelBridgePayload = {
  records: [
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.span",
      // @ts-expect-error body is a main-buffer field, not a renderer bridge field.
      body: "raw body",
    },
  ],
};

export const resourceAttributesAreRejectedAtRendererDtoBoundary: RendererOtelBridgePayload =
  {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
        // @ts-expect-error resourceAttributes are attached by the main runtime only.
        resourceAttributes: { "service.name": "renderer" },
      },
    ],
  };

export const droppedRecordsCountIsRejectedAtRendererDtoBoundary: RendererOtelBridgePayload =
  {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
        // @ts-expect-error droppedRecordsCount is a main-buffer field, not renderer input.
        droppedRecordsCount: 1,
      },
    ],
  };

export const mainOriginIsRejectedAtRendererDtoBoundary: RendererOtelBridgePayload =
  {
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          // @ts-expect-error renderer exception records cannot claim main origin.
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,
        },
      },
    ],
  };

export const preInitOriginIsRejectedAtRendererDtoBoundary: RendererOtelBridgePayload =
  {
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          // @ts-expect-error renderer exception records cannot claim pre-init origin.
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.PreInit,
        },
      },
    ],
  };

export const unsupportedExceptionFieldIsRejectedAtRendererDtoBoundary: RendererOtelBridgePayload =
  {
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
          // @ts-expect-error raw body is not an approved renderer exception attribute.
          body: "raw body",
        },
      },
    ],
  };
