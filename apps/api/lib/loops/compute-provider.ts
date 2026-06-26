/**
 * ComputeProvider abstraction — encapsulates compute-target-specific concerns.
 *
 * The orchestrator delegates to the provider for all target-specific operations
 * (context preparation, dispatch, cleanup, artifact ingestion) so the orchestrator
 * itself has zero `if (loop.computeTargetId)` branching.
 */

import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { HarnessType } from "@repo/api/src/types/compute-target";
import type {
  AdditionalRepoRefWithToken,
  Loop,
  LoopCommand,
} from "@repo/api/src/types/loop";
import type { LoopBranchMaterializationEnvelope } from "@repo/api/src/types/loop-body";
import type { LoopCommandHandler } from "./loop-commands/loop-command-handler";
import type { ContextPack } from "./loop-state";

// ---------------------------------------------------------------------------
// Launch context — resolved by the orchestrator, consumed by providers
// ---------------------------------------------------------------------------

/** Shared launch context assembled by the orchestrator before provider dispatch. */
export type LaunchContext = {
  loopId: string;
  organizationId: string;
  userId: string;
  command: LoopCommand;
  contextPack: ContextPack;
  closedLoopAuthToken: string;
  tokenId: string;
  expiresAt: Date;
  apiBaseUrl: string;
  anthropicApiKey: string | undefined;
  githubToken: string | undefined;
  committer: { name: string; email: string } | undefined;
  repo: { fullName: string; branch: string } | null;
  documentId: string | null;
  documentSlug: string | undefined;
  parentLoopId: string | null;
  parentS3StateKey: string | null;
  parentBranchName: string | null;
  parentSessionId: string | null;
  localRepoPath: string | undefined;
  computeTargetId: string | null;
  runnerCapabilities: JsonObject;
  additionalRepos?: AdditionalRepoRefWithToken[];
  branchMaterialization?: LoopBranchMaterializationEnvelope;
  desktopUserIntentSignature?: DesktopUserIntentSignature;
  harness?: HarnessType;
};

export type DesktopUserIntentSignature = {
  commandId: string;
  signature: string;
  signaturePayload: string;
  publicKeyFingerprint: string;
  body: JsonValue;
};

// ---------------------------------------------------------------------------
// Provider results
// ---------------------------------------------------------------------------

/**
 * Opaque prepared context returned by prepareContext().
 * ECS: contains s3StateKey, s3ContextKey, s3ContextUrl.
 * Desktop: empty (context travels inline in the relay payload).
 */
export type PreparedContext = {
  s3StateKey: string | null;
  s3ContextKey: string | null;
  s3ContextUrl: string | null;
};

/** Result returned by dispatch(). */
export type LaunchResult = {
  /** Provider-assigned ID: ECS taskArn or desktop commandId. */
  containerId: string;
  /** S3 state prefix (ECS) or null (desktop). */
  s3StateKey: string | null;
};

// ---------------------------------------------------------------------------
// Token metadata (downloaded from S3 for ECS, absent for desktop)
// ---------------------------------------------------------------------------

export type TokenMetadata = {
  tokensInput?: number;
  tokensOutput?: number;
  tokensByModel?: Record<
    string,
    {
      input: number;
      output: number;
      cacheCreation?: number;
      cacheRead?: number;
    }
  > | null;
};

// ---------------------------------------------------------------------------
// ComputeProvider type
// ---------------------------------------------------------------------------

/**
 * Encapsulates compute-target-specific concerns.
 * The orchestrator delegates to the provider for all target-specific operations.
 */
export type ComputeProvider = {
  /** Prepare and store the context pack (S3 upload for ECS, no-op for desktop). */
  prepareContext(ctx: LaunchContext): Promise<PreparedContext>;

  /** Dispatch the loop to the compute target. Returns containerId + s3StateKey. */
  dispatch(
    ctx: LaunchContext,
    prepared: PreparedContext
  ): Promise<LaunchResult>;

  /** Abort a running loop. Provider-specific cleanup. */
  abort(
    loopId: string,
    containerId: string,
    computeTargetId: string | null
  ): Promise<void>;

  /** Post-"started" event hook. ECS: scrub secrets. Desktop: no-op. */
  onStarted(loop: Loop): Promise<void>;

  /** Retrieve token metadata after completion. ECS: S3 download. Desktop: null. */
  getTokenMetadata(loop: Loop): Promise<TokenMetadata | null>;

  /**
   * Ingest artifacts from the appropriate source.
   * ECS: download from S3. Desktop: read from uploadedArtifacts.
   */
  ingestArtifacts(
    loop: Loop,
    organizationId: string,
    handler: LoopCommandHandler
  ): Promise<void>;

  /**
   * Cleanup on launch failure.
   * ECS: scrub secrets from S3, stop orphaned task.
   * Desktop: expire orphaned command, send kill signal.
   */
  cleanupOnLaunchFailure(
    loopId: string,
    organizationId: string,
    launchResult: Partial<LaunchResult>,
    error: unknown,
    computeTargetId: string | null
  ): Promise<void>;
};
