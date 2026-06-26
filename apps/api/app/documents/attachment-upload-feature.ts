import "server-only";

import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

export const MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY =
  "mcp-upload-attachment" as const;

export type AttachmentUploadFeatureIdentity = {
  userId: string;
  clerkUserId?: string | null;
};

/**
 * Evaluates the MCP attachment-upload rollout for API-key callers. Only an
 * explicit true from the exact PostHog key admits the mutation; unavailable,
 * false, null, or thrown flag evaluation all fail closed.
 */
export async function isMcpAttachmentUploadEnabled(
  identity: AttachmentUploadFeatureIdentity
): Promise<boolean> {
  try {
    for (const distinctId of resolveAttachmentUploadDistinctIds(identity)) {
      if (
        (await isFeatureFlagEnabledForDistinctId(
          MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY,
          distinctId
        )) === true
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    log.warn("mcp_upload_attachment_feature_flag_unavailable", {
      error: parseError(error),
    });
    return false;
  }
}

function resolveAttachmentUploadDistinctIds({
  clerkUserId,
  userId,
}: AttachmentUploadFeatureIdentity): string[] {
  return [
    ...new Set(
      [clerkUserId, userId].filter((value): value is string => Boolean(value))
    ),
  ];
}
