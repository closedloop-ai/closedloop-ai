/**
 * @file import-session-context.ts
 * @description The pure, pre-transaction state every import phase shares, and
 * the write-side dependency bundle the import entry points take.
 *
 * Extracted from `write-core.ts` (ISS-6168) so that file stays under its
 * grandfathered size while the owner-identity binding is threaded through it.
 * Nothing here touches the database: the derivations read the parsed session and
 * (for artifact refs) the filesystem, which is exactly why they can be computed
 * once up front and then reused by phases running in separate transactions.
 */
import {
  resolveSessionAttribution,
  type SessionAttributionResolverCache,
} from "../agent-sync/agent-session-attribution.js";
import {
  type ActivitySegmentRecord,
  classifyActivitySegments,
} from "../collectors/parsing/activity-segment-classifier.js";
import { extractArtifactRefs } from "../collectors/parsing/artifact-ref-extractor.js";
import { extractLaunchMetadataRefs } from "../collectors/parsing/artifact-ref-launch-metadata.js";
import { resolveSessionObservedAt } from "../collectors/parsing/artifact-ref-observed-at.js";
import type { ArtifactRefRecord } from "../collectors/parsing/artifact-ref-record.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import type { PullRequestPreservedFields } from "../pull-requests/pr-store.js";
import { RECENT_ACTIVITY_MS } from "./db-constants.js";
import { buildImportMetadata } from "./import-metadata-builders.js";
import type { createSqliteTokenUsageStore } from "./read-stores.js";
import type { SessionIdentityProvider } from "./session-owner-identity.js";
import { monitoredActivityOnlyMetadata } from "./synced-monitored-session-activity.js";
import type { TokenEventRecord } from "./token-event-contract.js";
import { mainAgentId } from "./write-core-main-agent-spine.js";
import { collectCreatedPullRequestHeadBranches } from "./write-core-pull-requests.js";

/**
 * The write-side dependencies every import entry point needs: billing-mode
 * classification, the owner-identity provider, and the log sink. Named once
 * rather than re-declared inline at `createSqliteImporter`,
 * {@link buildImportSessionContext}, `importSessionWithTx`, and
 * `importSessionIsolated`, so a new dependency reaches all four together.
 */
export type ImportSessionWriteDeps = {
  detectBillingMode: (harness: string, model?: string | null) => string;
  /** ISS-6168: resolves the signed-in owner stamped on a newly imported session. */
  getUserIdentity?: SessionIdentityProvider;
  log: (message: string) => void;
};

/**
 * Pure, transaction-independent state derived once per import and shared across
 * the per-record phases below. None of these values touch the database (they
 * read the parsed session and, for artifact refs, the filesystem), so deriving
 * them up front lets each phase run in its own isolated transaction (normal
 * ingest, {@link importSessionIsolated}) — or all on one shared transaction
 * (rebuild, {@link importSessionWithTx}) — without recomputing or holding a write
 * connection open while deriving.
 */
export type ImportSessionContext = {
  session: NormalizedSession;
  harness: Harness;
  now: string;
  recentlyActive: boolean;
  mainId: string;
  tokenSeries: NormalizedSession["tokenSeries"];
  earliestTokenTs: string | null;
  tokenEventsRecords: TokenEventRecord[];
  activitySegments: ActivitySegmentRecord[];
  sessionMetadata: string;
  linkedArtifactRefs: ArtifactRefRecord[];
  createdPrHeadBranches: Map<string, string | null>;
  pullRequestPreserved: ReadonlyMap<string, PullRequestPreservedFields>;
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
  detectBillingMode: (harness: string, model?: string | null) => string;
  // ISS-6168: reads the signed-in identity at INSERT time so an imported session
  // is attributed to its owner exactly as a live-hook session is. Undefined in
  // paths with no identity source; the row then persists a NULL owner, which
  // `claimUnownedSessionIdentity` repairs at the next db open, or sooner if an
  // identity is pushed into the db host while it is already running.
  getUserIdentity?: SessionIdentityProvider;
  // Threaded to persistArtifactLinks so a swallowed row-level upsert failure
  // emits a warning instead of dropping the link silently (see that function).
  log: (message: string) => void;
};

export function buildImportSessionContext(
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: ImportSessionWriteDeps,
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache,
  pullRequestPreserved?: ReadonlyMap<string, PullRequestPreservedFields>
): ImportSessionContext {
  const nowMs = Date.parse(now);
  const recentlyActive =
    session.fileModifiedAt != null &&
    Number.isFinite(session.fileModifiedAt) &&
    (Number.isNaN(nowMs) ? Date.now() : nowMs) - session.fileModifiedAt <
      RECENT_ACTIVITY_MS;
  const mainId = mainAgentId(session.sessionId);
  // FEA-1459 Fix 5: earliest token timestamp drives created_at for token rows.
  const tokenSeries = session.tokenSeries ?? [];
  const earliestTokenTs =
    tokenSeries.length > 0
      ? tokenSeries.reduce(
          (min, r) => (r.timestamp < min ? r.timestamp : min),
          tokenSeries[0].timestamp
        )
      : session.startedAt;
  // FEA-1459 Fix C: if tokenSeries is empty but tokensByModel is not, synthesize
  // one fallback record per model (all four parsers populate tokenSeries today;
  // guard for safety). Mirrors the legacy in-transaction derivation exactly.
  // FEA-3419: the synthesized record MUST carry the model's cacheWriteTtl —
  // its counts match the aggregate exactly, so conservation would otherwise
  // qualify and replace the TTL-premium-inclusive aggregate cost with a
  // 5m-only event sum, silently erasing the premium.
  const tokenEventsRecords: TokenEventRecord[] =
    tokenSeries.length > 0
      ? tokenSeries
      : Object.entries(session.tokensByModel ?? {}).map(([model, counts]) => ({
          timestamp: session.startedAt ?? now,
          model,
          input: counts.input,
          output: counts.output,
          cacheRead: counts.cacheRead,
          cacheWrite: counts.cacheWrite,
          ...(counts.cacheWriteTtl
            ? { cacheWriteTtl: { ...counts.cacheWriteTtl } }
            : {}),
        }));
  // FEA-1684: refs come from the transcript plus launch metadata
  // (.closedloop-ai/work/launch-metadata.json), resolved before any transaction
  // so no write connection is held open. observed_at: artifact-ref-observed-at.
  const launchAttribution = resolveSessionAttribution(
    session.cwd,
    attributionCache
  );
  const launchRefs = extractLaunchMetadataRefs(
    launchAttribution?.sourceArtifactId
      ? { sourceArtifactId: launchAttribution.sourceArtifactId }
      : null,
    resolveSessionObservedAt(session, now)
  );
  const artifactRefs = [...extractArtifactRefs(session, now), ...launchRefs];
  const sessionMetadata = buildImportMetadata(
    session,
    harness,
    monitoredActivityOnlyMetadata(artifactRefs)
  );
  const linkedArtifactRefs = artifactRefs.filter(
    (ref) => !ref.monitoredActivityOnly
  );
  // FEA-2267/FEA-2269: the activity-phase tiling is a pure, deterministic
  // derivation of the parsed session (no DB, no clock), so it is computed up
  // front alongside the other pre-transaction context and persisted by
  // importPhaseActivitySegments. `harness` selects the FEA-2268 evidence adapter.
  const activitySegments = classifyActivitySegments(session, harness);
  const createdPrHeadBranches =
    collectCreatedPullRequestHeadBranches(artifactRefs);
  return {
    session,
    harness,
    now,
    recentlyActive,
    mainId,
    tokenSeries,
    earliestTokenTs,
    tokenEventsRecords,
    activitySegments,
    sessionMetadata,
    linkedArtifactRefs,
    createdPrHeadBranches,
    pullRequestPreserved:
      pullRequestPreserved ?? new Map<string, PullRequestPreservedFields>(),
    tokenUsage,
    detectBillingMode: deps.detectBillingMode,
    getUserIdentity: deps.getUserIdentity,
    log: deps.log,
  };
}
