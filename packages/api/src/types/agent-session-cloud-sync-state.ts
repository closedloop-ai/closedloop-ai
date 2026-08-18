import { z } from "zod";
import { agentSessionCloudSyncStateValues } from "./agent-session-cloud-sync-state-constants";

/**
 * FEA (PRD-536 E6): the Zod-backed boundary half of the per-row local-vs-cloud
 * sync disclosure. The plain const-object enum, values tuple, union type, and
 * type guard live in the Zod-FREE `agent-session-cloud-sync-state-constants`
 * module so client bundles that only need the enum for a comparison/render don't
 * pull `zod` in (codex #3449). This module owns ONLY the strict wire/IPC schema;
 * callers that need the enum/guard import them directly from the constants
 * module (no barrel re-export here, keeping the module graph flat).
 */

/**
 * Strict boundary schema for the per-row sync-state field (FEA-3701 discipline):
 * the enum that crosses the IPC/serialization boundary is validated by a single
 * canonical schema rather than an ad-hoc string check, so an unknown wire value
 * is rejected at the boundary instead of silently rendering a wrong badge.
 */
export const agentSessionCloudSyncStateSchema = z.enum(
  agentSessionCloudSyncStateValues
);
