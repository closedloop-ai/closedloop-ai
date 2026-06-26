import { z } from "zod";
import { TelemetryAttribute } from "./attributes";
import {
  boundedText,
  hasMaxCodePointLength,
  hasNoControlCharacters,
  TelemetryTextMaxLength,
} from "./schema-primitives";

const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;

const isPathOnlyUrlComponent = (value: string) => {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  if (value.includes("://") || value.includes("?") || value.includes("#")) {
    return false;
  }
  const firstSegment = value.slice(1).split("/")[0] ?? "";
  const colonIndex = firstSegment.indexOf(":");
  const atIndex = firstSegment.indexOf("@");
  if (colonIndex !== -1 && atIndex !== -1 && colonIndex < atIndex) {
    return false;
  }
  return hasNoControlCharacters(value);
};

/** Path-only URL schema; full URLs, query strings, fragments, and auth are rejected. */
export const UrlPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => hasMaxCodePointLength(value, TelemetryTextMaxLength.UrlPath),
    `must contain at most ${TelemetryTextMaxLength.UrlPath} Unicode code points`
  )
  .refine(isPathOnlyUrlComponent, "must be a path-only URL component");

/** Strict span attribute schema for HTTP, code, error, and duration metadata. */
export const SpanTelemetrySchema = z
  .object({
    [TelemetryAttribute.HttpRequestMethod]: z
      .string()
      .regex(HTTP_METHOD_PATTERN),
    [TelemetryAttribute.HttpResponseStatusCode]: z
      .number()
      .int()
      .min(100)
      .max(599),
    [TelemetryAttribute.UrlPath]: UrlPathSchema,
    [TelemetryAttribute.DurationMs]: z.number().int().min(0).max(86_400_000),
    [TelemetryAttribute.CodeFunctionName]: boundedText(
      TelemetryTextMaxLength.CodeFunctionName
    ).optional(),
    [TelemetryAttribute.CodeFilePath]: boundedText(
      TelemetryTextMaxLength.CodeFilePath
    ).optional(),
    [TelemetryAttribute.CodeLineNumber]: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional(),
    [TelemetryAttribute.CodeColumnNumber]: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional(),
    [TelemetryAttribute.ErrorType]: boundedText(
      TelemetryTextMaxLength.ErrorType
    ).optional(),
  })
  .strict();

/** Parsed span telemetry attribute shape. */
export type SpanTelemetry = z.infer<typeof SpanTelemetrySchema>;
