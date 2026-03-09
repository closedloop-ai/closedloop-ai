import type { Loop } from "@repo/api/src/types/loop";

/**
 * Command handler as seen by the orchestrator.
 * Uses `downloadAndIngest` to avoid exposing the artifact type parameter.
 */
export type LoopCommandHandler = {
  /** Whether this command requires a target repo. */
  requiresRepo: boolean;

  /** Whether this command needs a parent loop's state (for resume/amend). */
  requiresParent: boolean;

  /** Whether to include the primary artifact content in the context pack. */
  includePrimaryArtifact: boolean;

  /**
   * Download artifacts from S3, then ingest them into the platform.
   * Encapsulates the typed download→ingest pairing internally.
   */
  downloadAndIngest: (
    stateKeyPrefix: string,
    loop: Loop,
    organizationId: string
  ) => Promise<void>;
};

/**
 * Define a command handler with type-safe artifact pairing.
 *
 * `downloadArtifacts` returns T, `ingest` consumes T — the generic ensures
 * they agree. The returned handler exposes `downloadAndIngest` which
 * sequences them, so the orchestrator never touches the raw artifact type.
 */
export function defineHandler<T>(config: {
  requiresRepo: boolean;
  requiresParent: boolean;
  includePrimaryArtifact: boolean;
  downloadArtifacts: (stateKeyPrefix: string) => Promise<T>;
  ingest: (loop: Loop, organizationId: string, artifacts: T) => Promise<void>;
}): LoopCommandHandler {
  return {
    requiresRepo: config.requiresRepo,
    requiresParent: config.requiresParent,
    includePrimaryArtifact: config.includePrimaryArtifact,
    async downloadAndIngest(stateKeyPrefix, loop, organizationId) {
      const artifacts = await config.downloadArtifacts(stateKeyPrefix);
      await config.ingest(loop, organizationId, artifacts);
    },
  };
}
