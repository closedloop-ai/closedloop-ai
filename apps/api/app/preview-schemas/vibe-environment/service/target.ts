import type { JsonObject } from "@repo/api/src/types/common";
import {
  normalizePreviewSchemaName,
  resolveSchemaName,
} from "@repo/database/schema-utils";
import {
  deriveBranchSchemaName,
  validateHost,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { createSslClient } from "@repo/database/scripts/db-utils";
import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { isPreviewSchema } from "@repo/database/scripts/preview-schema";
import {
  parseVibeEnvironmentMarker,
  readSchemaComment,
  type VibeEnvironmentMarker,
} from "@repo/database/scripts/vibe-environment";
import { VibeSeedRestoreError } from "@repo/database/scripts/vibe-environment-restore";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type pg from "pg";
import {
  IAM_NOT_CONFIGURED_MESSAGE,
  mintSchemaUrls,
} from "../../service/iam-schema-url";
import { VibeEnvironmentFailureReason } from "../constants";

/**
 * ISS-12056: the preamble every vibe environment request shares. It refuses
 * unless this deployment is stage itself (never a branch preview, whose S3
 * keyspace layer would prefix keys a second time) and wired to the
 * allowlisted non-production host, and the branch's schema is a preview
 * schema; then it opens one connection over an IAM URL minted for THAT
 * schema, so nothing here can read or write the runtime's own `public`.
 */

export type VibeEnvironmentFailure = {
  ok: false;
  reason: VibeEnvironmentFailureReason;
  message: string;
  /** A machine-readable code and details the workflow can act on. */
  code?: string;
  details?: JsonObject;
};

export type VibeEnvironmentTarget = { schema: string; databaseUrl: string };

const HOST_REFUSED_MESSAGE =
  "Refusing a vibe environment request: this deployment is not wired to the allowlisted non-production database host";

const WRONG_DEPLOYMENT_MESSAGE =
  "Refusing a vibe environment request on a branch preview deployment; send it to the stage API";

export async function resolveTarget(
  branch: string
): Promise<
  { ok: true; value: VibeEnvironmentTarget } | VibeEnvironmentFailure
> {
  const refusal = refuseDeployment(branch);
  if (refusal) {
    return refusal;
  }
  const schema = deriveBranchSchemaName(branch, normalizePreviewSchemaName);
  if (!isPreviewSchema(schema)) {
    return failure(
      VibeEnvironmentFailureReason.NotAPreviewSchema,
      `Refusing "${schema}": only branch preview schemas can be vibe environments`
    );
  }
  const urls = await mintSchemaUrls(schema);
  if (!urls) {
    return failure(
      VibeEnvironmentFailureReason.Failed,
      IAM_NOT_CONFIGURED_MESSAGE
    );
  }
  return { ok: true, value: { schema, databaseUrl: urls.databaseUrl } };
}

/**
 * Runs `work` on one connection to the target schema, only when its vibe
 * environment marker satisfies `accepts`; `notAccepted` is the refusal text.
 * Refusals and failures come back typed. Messages are sanitized because the
 * workflow prints them into an Actions log.
 */
export async function withVibeEnvironment<T>(
  target: VibeEnvironmentTarget,
  gate: {
    accepts: (marker: VibeEnvironmentMarker | null) => boolean;
    notAccepted: string;
  },
  work: (client: pg.Client) => Promise<T>
): Promise<T | VibeEnvironmentFailure> {
  const { schema } = target;
  const client = createSslClient(target.databaseUrl);
  try {
    await client.connect();
    const marker = parseVibeEnvironmentMarker(
      await readSchemaComment(client, schema)
    );
    if (!gate.accepts(marker)) {
      return failure(VibeEnvironmentFailureReason.WrongState, gate.notAccepted);
    }
    return await work(client);
  } catch (error) {
    const message = sanitizeOperatorMessageFragment(parseError(error));
    if (error instanceof VibeSeedRestoreError) {
      return failure(VibeEnvironmentFailureReason.Refused, message);
    }
    log.error("[vibe-environment] Request failed", { schema, error: message });
    return failure(
      VibeEnvironmentFailureReason.Failed,
      `Vibe environment request for "${schema}" failed: ${message}`
    );
  } finally {
    await client.end().catch(() => {
      // The request's own outcome is what the caller reports.
    });
  }
}

export function failure(
  reason: VibeEnvironmentFailureReason,
  message: string
): VibeEnvironmentFailure {
  return { ok: false, reason, message };
}

/**
 * A branch preview's runtime resolves its own `preview_*` schema; stage
 * resolves `public` (`null`), which is the only deployment these routes serve.
 */
function refuseDeployment(branch: string): VibeEnvironmentFailure | null {
  const runtimeSchema = resolveSchemaName({
    pgSchema: process.env.PGSCHEMA,
    vercelEnv: process.env.VERCEL_ENV,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  });
  if (runtimeSchema !== null) {
    log.error("[vibe-environment] Refusing: not the stage deployment", {
      branch,
      runtimeSchema,
    });
    return failure(
      VibeEnvironmentFailureReason.WrongDeployment,
      WRONG_DEPLOYMENT_MESSAGE
    );
  }
  const hostError = validateHost({
    pgHost: process.env.PGHOST,
    stagePgHost: process.env.STAGE_PGHOST,
  });
  if (hostError) {
    log.error("[vibe-environment] Refusing: host is not allowlisted", {
      branch,
      hostError,
    });
    return failure(
      VibeEnvironmentFailureReason.HostNotAllowed,
      HOST_REFUSED_MESSAGE
    );
  }
  return null;
}
