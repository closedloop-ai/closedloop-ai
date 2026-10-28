import "server-only";

import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";
import { MCP_UPLOAD_ATTACHMENT_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

/**
 * ISS-7778: the key now travels with its grant/restriction classification, so it
 * is read off the one definition rather than restated here.
 */
export const MCP_UPLOAD_ATTACHMENT_FEATURE_FLAG_KEY =
  MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key;

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
    MCP_UPLOAD_ATTACHMENT_SERVER_FLAG,
    identity,
    "mcp_upload_attachment_feature_flag_unavailable"
  );
}
