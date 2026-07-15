import { z } from "zod";
import { AppExceptionOrigin } from "./app-exception-origin";
import { TelemetryAttribute } from "./src/attributes";
import { boundedText, TelemetryTextMaxLength } from "./src/schema-primitives";

/** Strict app attribute schema for fleet identity, lifecycle, and exception metadata. */
export const AppTelemetrySchema = z
  .object({
    [TelemetryAttribute.AppInstallationId]: boundedText(
      TelemetryTextMaxLength.AppInstallationId
    ).optional(),
    [TelemetryAttribute.AppOrganizationId]: boundedText(
      TelemetryTextMaxLength.AppOrganizationId
    ).optional(),
    [TelemetryAttribute.DeploymentEnvironmentName]: boundedText(
      TelemetryTextMaxLength.DeploymentEnvironmentName
    ).optional(),
    [TelemetryAttribute.ExceptionType]: boundedText(
      TelemetryTextMaxLength.ExceptionType
    ).optional(),
    [TelemetryAttribute.ExceptionMessage]: boundedText(
      TelemetryTextMaxLength.ExceptionMessage
    ).optional(),
    [TelemetryAttribute.ExceptionStacktrace]: boundedText(
      TelemetryTextMaxLength.ExceptionStacktrace
    ).optional(),
    [TelemetryAttribute.AppExceptionOrigin]: z
      .enum([
        AppExceptionOrigin.PreInit,
        AppExceptionOrigin.Main,
        AppExceptionOrigin.Renderer,
      ])
      .optional(),
    [TelemetryAttribute.AppOperatingMode]: z
      .enum(["single_player", "multiplayer"])
      .optional(),
    [TelemetryAttribute.AppLifecycleEvent]: z
      .enum(["start", "heartbeat", "shutdown"])
      .optional(),
  })
  .strict();

/** Parsed app telemetry attribute shape. */
export type AppTelemetry = z.infer<typeof AppTelemetrySchema>;
