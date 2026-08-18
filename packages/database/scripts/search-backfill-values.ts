import { randomBytes } from "node:crypto";
import {
  resolveVersionFingerprint,
  routableComponentHashKey,
  routableComponentSlug,
} from "@repo/api/src/types/agent-component-analytics";

/**
 * Value helpers for the search-document backfill.
 *
 * Extracted from `backfill-search-documents.ts` so they can be unit-tested
 * without a Postgres transaction — that script's remaining helpers all take a
 * `TransactionClient` or run raw SQL, which is why these three had no coverage
 * despite being the parts most likely to be silently wrong. The source file was
 * also ~1,000 lines, well past the 500-line smell.
 *
 * These are pure apart from `uuidV7`, which reads the clock and the CSPRNG.
 */

/**
 * Generate a RFC-9562 UUIDv7 (48-bit big-endian Unix-ms timestamp, 4-bit
 * version, 2-bit variant, 74 random bits). Used to fill the projection PK in
 * the raw upsert so it matches schema.prisma's `@default(uuid(7))` — Postgres
 * has no built-in v7 generator and the raw INSERT bypasses Prisma's
 * client-side default.
 *
 * The time-ordered prefix is the point, not a detail: it keeps the primary-key
 * B-tree append-mostly as the projection grows. A v4-shaped id would still
 * insert, so nothing downstream would fail loudly if this regressed.
 */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  // Big-endian 48-bit Unix-ms timestamp in bytes 0..5. Division/modulo (no
  // bitwise) keeps this safe above 32 bits.
  let timestamp = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  // Version 7 in the high nibble of byte 6; RFC-4122 variant (10xx) in byte 8.
  // biome-ignore lint/suspicious/noBitwiseOperators: UUID v7 version/variant bits require bitwise ops (RFC 9562)
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  // biome-ignore lint/suspicious/noBitwiseOperators: UUID v7 version/variant bits require bitwise ops (RFC 9562)
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Build a branch's searchable body from its repo full name and base branch.
 * Returns null when neither is present so the projection stores SQL NULL.
 */
export function branchSearchBody(
  repositoryFullName: string,
  baseBranch: string | null
): string | null {
  const parts = [repositoryFullName, baseBranch].filter(
    (p): p is string => p !== null && p.length > 0
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * FEA-4335: the routable search slug for a backfilled agent component. Prefers
 * the content-hash detail key (`${kind}::${fingerprint}`) so same-named
 * different-content components resolve to DISTINCT detail pages (matching the
 * write-hook `agentComponentProjection`); a hash-less legacy row falls back to
 * the name-level `routableComponentSlug` (null on an empty identity ⇒
 * non-link).
 */
export function backfillAgentComponentSlug(
  componentKind: string,
  componentKey: string | null,
  name: string | null,
  contentHash: string | null
): string | null {
  const fingerprint = resolveVersionFingerprint(contentHash);
  if (fingerprint) {
    return routableComponentHashKey(
      componentKind,
      fingerprint,
      componentKey,
      name
    );
  }
  return routableComponentSlug(componentKind, componentKey, name);
}
