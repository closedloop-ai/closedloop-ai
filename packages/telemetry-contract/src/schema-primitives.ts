import { z } from "zod";

/** Maximum text lengths enforced by generated schemas and runtime validation. */
export const TelemetryTextMaxLength = {
  ServiceName: 128,
  ServiceVersion: 128,
  AppInstallationId: 128,
  DeploymentEnvironmentName: 128,
  ExceptionType: 128,
  ExceptionMessage: 2048,
  ExceptionStacktrace: 16_384,
  UrlPath: 2048,
  CodeFunctionName: 256,
  CodeFilePath: 1024,
  ErrorType: 256,
  GenAiRequestModel: 256,
  GenAiResponseId: 256,
} as const;

/** Returns true when a string contains no ASCII control characters. */
export const hasNoControlCharacters = (value: string) =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && codePoint !== 0x7f;
  });

/** Counts Unicode code points, not UTF-16 code units, against maxLength. */
export const hasMaxCodePointLength = (value: string, maxLength: number) =>
  Array.from(value).length <= maxLength;

/** Builds a non-empty bounded text schema without control characters. */
export const boundedText = (maxLength: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => hasMaxCodePointLength(value, maxLength),
      `must contain at most ${maxLength} Unicode code points`
    )
    .refine(hasNoControlCharacters, "must not contain control characters");
