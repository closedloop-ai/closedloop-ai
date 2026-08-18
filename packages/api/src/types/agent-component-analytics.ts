/**
 * Agent-component analytics DTOs — token-trend time series (AC-018).
 *
 * Shared response shapes for:
 *   GET /agent-components/{slug}/token-trend
 *
 * The ranking and compliance DTOs live in `packages/api/src/types/analytics.ts`
 * (already established by the ranking/compliance services). This file extends
 * that module with the per-(component, model) token-trend time-series types.
 *
 * Types follow the repo-sanctioned `as const` + `(typeof X)[keyof typeof X]`
 * pattern; no TypeScript `enum`. Kept in `packages/api/src/types/` because
 * they are consumed by BOTH the web surface (`apps/app`) and the API server.
 *
 * @repo/api MUST NOT import from @repo/app or apps/*.
 */

// ---------------------------------------------------------------------------
// Token trend
// ---------------------------------------------------------------------------

/**
 * A single time-series data point for token/cost/latency/truncation metrics
 * per (component, model).
 *
 * Grain: one point per (AgentComponentSessionUsage row × AgentSessionTokenUsage
 * model row). Token values are scoped to the model within the session.
 */
export type TokenTrendPoint = {
  /** Session artifact id (the time-series grain is per session × model). */
  sessionId: string;
  /** ISO timestamp when the session started. */
  sessionStartedAt: string;
  /** AI model name (e.g. "claude-opus-4-5"). */
  model: string;
  /** Total input tokens for this (session, model) pair. */
  inputTokens: number;
  /** Total output tokens for this (session, model) pair. */
  outputTokens: number;
  /** Cache-read tokens. */
  cacheReadTokens: number;
  /** Cache-write tokens. */
  cacheWriteTokens: number;
  /** Estimated cost in USD for this (session, model) pair. */
  estimatedCostUsd: number;
  /**
   * Session wall-clock runtime in milliseconds (latency proxy).
   * Sourced from `AgentSessionUsageRollup.runtimeMs` when available;
   * falls back to `sessionEndedAt - sessionStartedAt`. null when neither
   * source is available.
   */
  runtimeMs: number | null;
  /**
   * Number of invocations of the component in this session (from
   * AgentComponentSessionUsage.invocationCount).
   */
  componentInvocations: number;
  /**
   * Number of component-level errors in this session (from
   * AgentComponentSessionUsage.errorCount). Used as a truncation/failure proxy.
   */
  componentErrorCount: number;
};

/**
 * Response envelope for GET /agent-components/{slug}/token-trend.
 */
export type TokenTrendResponse = {
  /**
   * The org-level identity slug of the component.
   * Format: `${componentKind}::${normalizedKey}`
   */
  slug: string;
  /**
   * Time-series data points, one per (session × model) pair that has both
   * AgentComponentSessionUsage and AgentSessionTokenUsage rows.
   * Ordered ascending by `sessionStartedAt`.
   */
  points: TokenTrendPoint[];
  /**
   * Deduplicated, sorted list of distinct models observed across all points.
   * Convenience for frontends building a model legend.
   */
  models: string[];
};

// ---------------------------------------------------------------------------
// Org-identity slug codec (SSOT)
// ---------------------------------------------------------------------------

/**
 * The org-level component identity slug is a cross-surface CONTRACT: desktop
 * (`apps/desktop`) and cloud (`apps/api`) must encode/decode it identically or
 * component identities silently mismatch between the two surfaces. This module
 * is the single source of truth for that codec — a pure-string leaf with no
 * imports, so it is safe to consume from the desktop main process (a runtime
 * value import here does not pull `@repo/api`'s server-only closure into the
 * pglite boot path — cf. #1618/#1620).
 */

/**
 * Normalize a component key the way the org-identity slug does: prefer
 * `componentKey`, fall back to `name`, lowercase + trim for dedup.
 */
export function normalizeComponentKey(
  componentKey: string | null | undefined,
  name?: string | null
): string {
  return (componentKey ?? name ?? "").toLowerCase().trim();
}

/**
 * Encode a component's org-level identity slug: `${kind}::${normalizedKey}`
 * where `normalizedKey = (componentKey ?? name ?? "").toLowerCase().trim()`.
 */
export function encodeComponentSlug(
  kind: string,
  componentKey: string | null | undefined,
  name?: string | null
): string {
  return `${kind}::${normalizeComponentKey(componentKey, name)}`;
}

/**
 * Decode a `${kind}::${key}` slug back into its parts. Returns `null` when the
 * slug has no `::` separator (invalid format).
 */
export function decodeComponentSlug(
  slug: string
): { kind: string; key: string } | null {
  const sep = slug.indexOf("::");
  if (sep === -1) {
    return null;
  }
  return { kind: slug.slice(0, sep), key: slug.slice(sep + 2) };
}

/**
 * The org-identity slug for a ROUTABLE component reference, or `null` when the
 * component has no identity (both `componentKey` and `name` null/blank). An
 * empty identity encodes to a `${kind}::` handle that cannot resolve back to a
 * detail row, so search/route consumers that would build `/agents/<slug>` must
 * treat a null here as "not linkable" and render a non-link instead of a 404.
 * Distinct from {@link encodeComponentSlug}, whose `${kind}::` output is fine as
 * a dedup/aggregation KEY but not as a navigation target.
 */
export function routableComponentSlug(
  kind: string,
  componentKey: string | null | undefined,
  name?: string | null
): string | null {
  if (normalizeComponentKey(componentKey, name) === "") {
    return null;
  }
  return encodeComponentSlug(kind, componentKey, name);
}

/**
 * FEA-3982 (Slice 2): the fingerprint that disambiguates two components that
 * share a name but differ in bytes. Prefer the exact provenance-free
 * `DefinitionVersion.definitionHash` when the row is linked; else fall back to
 * the coarse `AgentComponent.contentHash` (raw sha256); else null for a legacy /
 * event-minted row with no captured definition (skew — such rows collapse under
 * the name-only identity so they still render exactly once).
 *
 * Cross-surface SSOT: the cloud service (`apps/api/app/agent-components`) and the
 * desktop-local IPC reader (`apps/desktop/src/main/dashboard`) both key their
 * org-level list dedup on this fingerprint, so they must derive it identically.
 */
export function resolveVersionFingerprint(
  contentHash: string | null | undefined,
  definitionHash?: string | null
): string | null {
  return definitionHash ?? contentHash ?? null;
}

// ---------------------------------------------------------------------------
// FEA-4335: content-hash-based routable component key.
//
// Product decision (Mike Angstadt): a component's IDENTITY is its content byte
// hash. Two components are the SAME iff their content byte hashes are identical
// and DIFFERENT iff the hashes differ — regardless of name, `kind::slug`, or
// install path. The byte-identical `testing_agent.md` installed at two different
// paths is ONE tracked component (same bytes → same hash → one identity); two
// different-content components that both normalize to `skill::deploy` are TWO
// components.
//
// The pre-FEA-4335 detail-page URI keyed on the NAME-level `${kind}::${key}`
// slug (`encodeComponentSlug`), so two materially-different components sharing a
// normalized name COLLIDED onto one detail URI. The routable key below keys off
// the path/name-independent content fingerprint instead — `${kind}::${hash}` —
// so distinct-content components get distinct URIs while byte-identical installs
// (any name/path) share one. The name-level slug stays the LIST dedup/family key
// and remains a compatibility routing target: an old `${kind}::${name}` detail
// link still resolves via the name fallback below (skew-safe).
//
// `kind` is retained in the key because the content fingerprint is itself
// kind-scoped (`computeDefinitionHash` folds the component kind into the
// pre-image) and the whole codec is `${kind}::${segment}`-shaped; a skill and a
// command can never share an identity even at an identical raw `contentHash`.
// ---------------------------------------------------------------------------

// A content fingerprint is a full 64-char lowercase-hex SHA-256: the exact
// provenance-free `DefinitionVersion.definitionHash` (`computeDefinitionHash` →
// `sha256Hex`) and the coarse `AgentComponent.contentHash`
// (`sha256Hex(def.content)`) are BOTH the untruncated digest. Matching exactly
// 64 hex chars (not a `{8,64}` range) is what keeps a legacy, hash-less
// component whose NORMALIZED NAME happens to be short lowercase-hex (e.g. a
// skill named `deadbeef`) from being misread as a content-hash key and
// mis-resolved — a real name would have to be exactly 64 hex chars to collide,
// which no human/tool-authored component name is.
const CONTENT_HASH_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * FEA-4335: the routable content-hash key for a component's detail URI, or the
 * name-level slug as a legacy fallback.
 *
 * When a content `fingerprint` (`resolveVersionFingerprint(contentHash,
 * definitionHash)`) is present the key is `${kind}::${fingerprint}` — a
 * path/name-independent identity, so byte-identical installs collapse to one URI
 * and distinct-content same-named components split into distinct URIs. When the
 * fingerprint is null (a legacy / event-minted row with no captured definition),
 * it falls back to the name-level `encodeComponentSlug` so such rows stay
 * routable exactly as before (skew-safe).
 *
 * Cross-surface SSOT: web + desktop href builders and the detail/token-trend
 * route resolution must derive and decode this key identically or navigation
 * silently mismatches between surfaces.
 */
export function routableComponentHashKey(
  kind: string,
  fingerprint: string | null | undefined,
  componentKey: string | null | undefined,
  name?: string | null
): string {
  if (fingerprint) {
    return `${kind}::${fingerprint}`;
  }
  return encodeComponentSlug(kind, componentKey, name);
}

/**
 * FEA-4335: decode a routable component key back into its parts. Returns the
 * `kind` plus EITHER a content `fingerprint` (when the second segment is a
 * content hash — new content-hash keys) OR a name-level `key` (when it is not —
 * legacy `${kind}::${name}` links). Exactly one of `fingerprint`/`key` is
 * non-null. Returns `null` when the key has no `::` separator (invalid format).
 *
 * The discriminator is purely the shape of the second segment: an exactly
 * 64-char lowercase-hex string is treated as a content fingerprint (every real
 * `contentHash`/`definitionHash` is a full 64-char SHA-256); anything else is a
 * name. Requiring the full 64 chars keeps a legacy hash-less component whose
 * normalized name is short hex (e.g. `deadbeef`) resolving as a NAME, not a
 * mis-read fingerprint.
 */
export function decodeComponentHashKey(key: string): {
  kind: string;
  fingerprint: string | null;
  key: string | null;
} | null {
  const decoded = decodeComponentSlug(key);
  if (!decoded) {
    return null;
  }
  if (CONTENT_HASH_KEY_RE.test(decoded.key)) {
    return { kind: decoded.kind, fingerprint: decoded.key, key: null };
  }
  return { kind: decoded.kind, fingerprint: null, key: decoded.key };
}

/**
 * FEA-3982 (Slice 2): the org-level *row* identity key the list dedup buckets
 * on. Previously the name-only `slug`; now the `slug` PLUS the version
 * fingerprint so two same-named components with different bytes bucket into two
 * distinct rows, while a hash-less legacy row keeps the name-only key and still
 * collapses to a single row (version-skew safe). The `slug` stays name-level on
 * the emitted row (detail/nav key), so old name-only detail links keep
 * resolving; the fingerprint only widens the LIST dedup granularity.
 */
export function fingerprintIdentityKey(
  slug: string,
  fingerprint: string | null
): string {
  return fingerprint ? `${slug}@${fingerprint}` : slug;
}

/**
 * FEA-3982 (Slice 2): the short version badge surfaced next to same-named rows
 * so a human can tell "same version" from "two different file contents". The
 * first 8 lowercase-hex chars of the fingerprint, or null when the row has no
 * captured definition (nothing to badge).
 */
export function shortFingerprint(fingerprint: string | null): string | null {
  return fingerprint ? fingerprint.slice(0, 8) : null;
}

/**
 * FEA-3982 (wongk decision): the fingerprint identity key a *usage* row (an
 * `AgentComponentSessionUsage` row — FK-linked OR orphaned/null-FK) belongs to.
 *
 * Usage rows carry their OWN version identity at invocation time
 * (`componentVersionHash`, and — once the F1 backfill links it — a
 * `definitionVersionId` the caller resolves to a `definitionHash`). That carried
 * hash — NOT the current inventory row's fingerprint — decides which version
 * bucket the usage attributes to: a device that moved from hash A to hash B keeps
 * its historical A sessions on the A bucket even though the inventory row now
 * reads B. When the usage row carries a resolvable version hash it folds into the
 * MATCHING version bucket (`slug@fingerprint`); when it carries none it stays on
 * the name-level (`slug`) bucket — version-skew safe.
 *
 * Cross-surface SSOT: the cloud fold (`apps/api/app/agent-components/identity.ts`
 * — both the FK-linked `aggregateUsageIntoMerged` lane and the orphan
 * `foldOrphanUsageIntoMerged` lane) and the desktop-local usage lanes
 * (`apps/desktop/src/main/dashboard/shared-agent-components-api.ts`) both route
 * usage through this one helper so the two surfaces attribute identically. The
 * desktop store has no `definitionVersionId`, so it passes `definitionHash`
 * omitted and attributes on `componentVersionHash` alone — the same fallback the
 * cloud takes for a still-unlinked usage row.
 */
export function usageVersionIdentityKey(
  slug: string,
  componentVersionHash: string | null | undefined,
  definitionHash?: string | null
): string {
  return fingerprintIdentityKey(
    slug,
    resolveVersionFingerprint(componentVersionHash, definitionHash)
  );
}
