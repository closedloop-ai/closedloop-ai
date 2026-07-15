import type { Attributes, AttributeValue, HrTime } from "@opentelemetry/api";
import {
  type DesktopOtelInstrumentationScope,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "./renderer-otel-bridge-constants.js";

// Shared, dependency-light helpers used by both the main-process
// (`src/main/app-otel-runtime.ts`) and renderer-process
// (`src/renderer/app-otel-runtime.ts`) OTel runtimes. This module deliberately
// avoids zod / Node built-ins so the renderer can import it without tripping
// the `renderer-otel-runtime-local-only` dependency-cruiser rule (see
// `scripts/dependency-cruiser.config.cjs`).

const CONTROL_CHARACTER_MAX_CODE = 0x1f;
const DELETE_CHARACTER_CODE = 0x7f;

export function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= CONTROL_CHARACTER_MAX_CODE ||
        codePoint === DELETE_CHARACTER_CODE)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeAttributes(
  attributes: Record<string, unknown>
): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, AttributeValue] => isAttributeValue(entry[1])
    )
  );
}

function isAttributeValue(value: unknown): value is AttributeValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (item) =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
  );
}

export function normalizeInstrumentationScope(scope: {
  name?: string;
  version?: string;
}): DesktopOtelInstrumentationScope | undefined {
  if (!scope.name) {
    return undefined;
  }
  return {
    name: scope.name,
    ...(scope.version ? { version: scope.version } : {}),
  };
}

export function hrTimeToUnixNanoString(hrTime: HrTime): string {
  return (BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1])).toString();
}

export function isTerminalRendererOtelResult(
  result: RendererOtelExportResult
): boolean {
  return (
    !result.ok &&
    (result.reason === RendererOtelExportFailureReason.Disabled ||
      result.reason === RendererOtelExportFailureReason.Unavailable ||
      result.reason === RendererOtelExportFailureReason.UntrustedSender)
  );
}
