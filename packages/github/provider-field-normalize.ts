import { createHash } from "node:crypto";

// Collapse runs of whitespace to a single space before trimming/truncating.
const PROVIDER_TEXT_NORMALIZE_REGEX = /\s+/g;

/**
 * Pure normalization/hashing helpers for GitHub provider fields (status-check
 * rollup projection). Split out of index.ts (PLN-1535) — no GitHub client,
 * purely string/URL/hash shaping, used by the status-check node mappers.
 */
export function parseProviderTimestamp(value: string | null): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function getStatusCheckDedupeKey(name: string): string {
  return name.toLowerCase();
}

export function hashProviderKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 64);
}

export function normalizeProviderText(
  value: string | null | undefined,
  maxLength: number
): string | null {
  const normalized = value
    ?.replace(PROVIDER_TEXT_NORMALIZE_REGEX, " ")
    .trim()
    .slice(0, maxLength);
  return normalized ? normalized : null;
}

export function normalizeProviderStatus(
  value: string | null | undefined
): string | null {
  const normalized = normalizeProviderText(value, 64);
  return normalized ? normalized.toUpperCase() : null;
}

export function sanitizeProviderUrl(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  if (!(trimmed && trimmed.length <= 2048)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
