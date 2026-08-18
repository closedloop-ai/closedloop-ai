import type { JsonObject } from "@repo/api/src/types/common";
import { compactMetadataForPreview } from "@repo/lib/agent-sessions/metadata-preview";

/**
 * FEA-3033: server-side defense-in-depth strip for persisted session/agent
 * `metadata` blobs.
 *
 * The desktop client already minimizes session `metadata` before sync via
 * `compactSessionMetadataForSync` in
 * `apps/desktop/src/main/agent-sync/agent-session-sync-payload.ts` — it drops
 * `messages[].content`, keeps only an allowlist of message fields, and caps
 * message count / nesting depth / string length. But the cloud ingest only runs
 * a Postgres-JSON validity + key-collision pass (`sanitizePostgresJson`) — NOT a
 * content strip — and then persists `session.metadata` and each agent's
 * `metadata` verbatim (`service.ts` upsert). A version-skewed older desktop
 * build, or any non-desktop caller (direct API, MCP, test harness), can
 * therefore put full `metadata.messages[]` (raw prompts, source code, secrets)
 * into the payload and have it stored raw until the retention sweep.
 *
 * FEA-3693: both this cloud strip and the desktop producer now delegate to the
 * ONE shared preview contract (`compactMetadataForPreview` in
 * `@repo/lib/agent-sessions/metadata-preview`), so the two lanes emit
 * byte-identical `metadata` for the same normalized transcript — including the
 * per-message preview floor and `textTruncation` markers. For a compliant
 * desktop payload the compaction is idempotent; it only bites when a caller
 * ships un-minimized content. Unlike the desktop, agent `metadata` is never
 * minimized producer-side (`sync-source.ts` ships it raw), so the same strip is
 * applied to both session and agent metadata here.
 */

/**
 * Reduce an arbitrary `metadata` blob to the bounded, content-stripped shape the
 * cloud is allowed to persist. Returns `null` for non-objects and for objects
 * that compact to nothing, matching the desktop `compactSessionMetadataForSync`
 * contract. Delegates to the shared FEA-3693 preview contract.
 */
export function sanitizeMetadataForPersist(
  metadata: unknown
): JsonObject | null {
  return compactMetadataForPreview(metadata);
}
