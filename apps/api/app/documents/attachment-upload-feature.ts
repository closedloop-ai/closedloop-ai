import "server-only";

import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";

export const MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY =
  "mcp-upload-attachment" as const;

export type AttachmentUploadFeatureIdentity = FeatureFlagIdentity;

/**
 * Evaluates the MCP attachment-upload rollout for API-key callers. Only an
 * explicit true from the exact PostHog key admits the mutation; unavailable,
 * false, null, or thrown flag evaluation all fail closed.
 */
export function isMcpAttachmentUploadEnabled(
  identity: AttachmentUploadFeatureIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY,
    identity,
    "mcp_upload_attachment_feature_flag_unavailable"
  );
}
