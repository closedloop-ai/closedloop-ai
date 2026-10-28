import { z } from "zod";

/** Maximum text lengths enforced by generated schemas and runtime validation. */
export const TelemetryTextMaxLength = {
  ServiceName: 128,
  ServiceVersion: 128,
  AppInstallationId: 128,
  AppClientVersion: 64,
  DeviceId: 128,
  AppOrganizationId: 64,
  DeploymentEnvironmentName: 128,
  ExceptionType: 128,
  ExceptionMessage: 2048,
  ExceptionStacktrace: 16_384,
  UrlPath: 2048,
  CodeFunctionName: 256,
  CodeFilePath: 1024,
  ErrorType: 256,
  ArtifactType: 64,
  ArtifactStatus: 64,
  GenAiRequestModel: 256,
  GenAiResponseId: 256,
  UpdateVersion: 128,
} as const;

export const TelemetryDurationMsMax = 86_400_000;

/**
 * Canonical UUID shape for every attribute that carries an opaque identifier.
 *
 * Case-insensitivity is spelled into the character classes rather than carried
 * by an `i` flag: the generated JSON Schema exports this as a bare `pattern`,
 * which has no flags, so an `i` here would make the Zod validator and the
 * published schema disagree about uppercase input — two representations of one
 * attribute accepting different sets. Shared rather than re-declared per module
 * so `sync.batch_id` and `routine.id` cannot drift into accepting different
 * strings for the same stated shape.
 */
export const TELEMETRY_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

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
