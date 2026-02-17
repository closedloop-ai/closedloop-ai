import type { PreviewDeploymentMetadata } from "./external-link";

/** Parsed preview deployment with its URL. */
export type PreviewDeploymentInfo = PreviewDeploymentMetadata & {
  url: string | null;
};

/**
 * Type-safe parser for PREVIEW_DEPLOYMENT metadata JSON.
 * Returns null if metadata is missing or not a valid object.
 */
export function parsePreviewDeploymentMetadata(
  metadata: unknown
): PreviewDeploymentMetadata | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }

  const data = metadata as Record<string, unknown>;

  return {
    state: typeof data.state === "string" ? data.state : null,
    environment: typeof data.environment === "string" ? data.environment : null,
    ref: typeof data.ref === "string" ? data.ref : null,
    sha: typeof data.sha === "string" ? data.sha : null,
  };
}
