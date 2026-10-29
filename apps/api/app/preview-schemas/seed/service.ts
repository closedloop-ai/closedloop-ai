import { validateHost } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { isPreviewSchema } from "@repo/database/scripts/preview-schema";
import { runPreviewSeedInProcess } from "@repo/database/scripts/preview-seed";
import {
  SeedAdmissionRefusal,
  withPreviewSeedAdmission,
} from "@repo/database/scripts/preview-seed-lock";
import { readVibeEnvironmentMarker } from "@repo/database/scripts/vibe-environment";
import { log } from "@repo/observability/log";
import {
  IAM_NOT_CONFIGURED_MESSAGE,
  mintSchemaUrls,
} from "../service/iam-schema-url";
import { SeedFailureReason } from "./constants";

/**
 * ISS-6804: seeds ONE branch preview schema with the FEA-1715 Seed Sandbox,
 * in-process, from an api-stage runtime function.
 *
 * Why this exists: the migration pipeline already calls `runPreviewSeed` after
 * every preview migrate — but that spawns `pnpm`, which a Vercel function does
 * not have, so a preview created through `/preview-schemas/ensure` (ISS-6802)
 * comes back cloned from stage `public` and never seeded. This route runs the
 * same seed program (`runSeedProgram`, same args, same env) without a
 * subprocess, as its OWN request so it has its own 300s budget rather than
 * competing with migrate + clone inside the ensure's.
 *
 * Preview schemas only, enforced twice: the derived name must be `preview_*`
 * before a URL is minted, and `runPreviewSeedInProcess` re-checks. The host
 * invariant is the ensure route's (`validateHost`, fails closed) — the seed
 * writes rows into a schema on whatever RDS `PGHOST` names, and production is
 * where `STAGE_PGHOST` is not set.
 */

/** Same reasoning as the ensure route's message: nothing about hosts. */
const HOST_REFUSED_MESSAGE =
  "Refusing to seed a schema: this deployment is not wired to the allowlisted non-production database host";

export type SeedSchemaResult =
  | {
      ok: true;
      branch: string;
      schema: string;
      organizationId: string;
      userId: string;
      elapsedMs: number;
    }
  | {
      ok: true;
      branch: string;
      schema: string;
      /**
       * ISS-12056: the schema is a vibe environment, which this seed never
       * writes: its own workflow seeds it, or it was asked to stay blank.
       */
      skipped: typeof SEED_SKIPPED_VIBE_ENVIRONMENT;
    }
  | { ok: false; reason: SeedFailureReason; message: string };

export const SEED_SKIPPED_VIBE_ENVIRONMENT = "vibe_environment";

export async function seedPreviewSchema(
  branch: string,
  schema: string
): Promise<SeedSchemaResult> {
  const hostError = validateHost({
    pgHost: process.env.PGHOST,
    stagePgHost: process.env.STAGE_PGHOST,
  });
  if (hostError) {
    log.error("[preview-schema-seed] Refusing: host is not allowlisted", {
      branch,
      schema,
      hostError,
    });
    return {
      ok: false,
      reason: SeedFailureReason.HostNotAllowed,
      message: HOST_REFUSED_MESSAGE,
    };
  }

  if (!isPreviewSchema(schema)) {
    return {
      ok: false,
      reason: SeedFailureReason.NotAPreviewSchema,
      message: `Refusing to seed "${schema}": only preview schemas are seeded`,
    };
  }

  const urls = await mintSchemaUrls(schema);
  if (!urls) {
    return {
      ok: false,
      reason: SeedFailureReason.Failed,
      message: IAM_NOT_CONFIGURED_MESSAGE,
    };
  }

  if ((await readVibeEnvironmentMarker(urls.databaseUrl, schema)) !== null) {
    log.info("[preview-schema-seed] Skipping a vibe environment", {
      branch,
      schema,
    });
    return {
      ok: true,
      branch,
      schema,
      skipped: SEED_SKIPPED_VIBE_ENVIRONMENT,
    };
  }

  log.info("[preview-schema-seed] Seeding preview schema", { branch, schema });
  // Schema-scoped admission, so a duplicate dispatch or a replayed token cannot
  // run a second seed against this schema concurrently (review: davetho).
  const admission = await withPreviewSeedAdmission(
    { databaseUrl: urls.databaseUrl, schema },
    () =>
      runPreviewSeedInProcess(
        urls.databaseUrl,
        schema,
        process.env,
        createSanitizedSeedLogger()
      )
  );

  if (!admission.admitted) {
    return refuseUnadmittedSeed(branch, schema, admission);
  }
  const result = admission.result;

  if (!result.ran) {
    // Unreachable after the `isPreviewSchema` check above; kept as the typed
    // second guard the seed helper itself provides.
    return {
      ok: false,
      reason: SeedFailureReason.NotAPreviewSchema,
      message: `Refusing to seed "${schema}": only preview schemas are seeded`,
    };
  }
  if (!result.ok) {
    // The seed's own error text can quote the connection it was handed
    // (guard messages, pg errors), and this body is printed by a GitHub Actions
    // step: same sanitizer, same reason as the ensure route (ISS-6403).
    const message = sanitizeOperatorMessageFragment(result.error);
    log.error("[preview-schema-seed] Seed failed", {
      branch,
      schema,
      error: message,
    });
    return {
      ok: false,
      reason: SeedFailureReason.Failed,
      message: `Failed to seed schema "${schema}": ${message}`,
    };
  }

  const { organizationId, userId, elapsedMs } = result.summary;
  log.info("[preview-schema-seed] Preview schema seeded", {
    branch,
    schema,
    organizationId,
    elapsedMs,
  });
  return { ok: true, branch, schema, organizationId, userId, elapsedMs };
}

/**
 * Answers a request the admission gate turned away.
 *
 * A contended lock is not a seed failure: the identical work is already in
 * flight, so it answers 409 and says so, rather than reporting a failure that
 * did not happen. A gate that could not be established at all is a real 500 —
 * the two are kept distinct so a duplicate dispatch cannot look like a broken
 * seed, nor a broken database like a duplicate.
 */
function refuseUnadmittedSeed(
  branch: string,
  schema: string,
  admission: { refusal: SeedAdmissionRefusal; detail: string }
): SeedSchemaResult {
  if (admission.refusal === SeedAdmissionRefusal.Contended) {
    log.info("[preview-schema-seed] Already seeding this schema", {
      branch,
      schema,
    });
    return {
      ok: false,
      reason: SeedFailureReason.AlreadyRunning,
      message: `A seed is already running for "${schema}"`,
    };
  }
  const detail = sanitizeOperatorMessageFragment(admission.detail);
  log.error("[preview-schema-seed] Seed admission unavailable", {
    branch,
    schema,
    error: detail,
  });
  return {
    ok: false,
    reason: SeedFailureReason.Failed,
    message: `Failed to seed schema "${schema}": could not acquire the seed admission lock: ${detail}`,
  };
}

/**
 * The logger the seed program writes through on the HTTP path.
 *
 * `runSeedProgram` and `runPreviewSeedInProcess` default to `console` and emit
 * the RAW failure — a pg error or guard message that can quote the IAM database
 * URL it was handed — before this service sanitizes the copy it RETURNS. In an
 * api-stage function that console is the Vercel log, so the redaction has to
 * happen at the sink too, not only on the response (review: davetho).
 *
 * The CLI is untouched: it passes no logger and still gets plain `console`, so
 * an operator running `pnpm seed` keeps full diagnostics.
 */
export function createSanitizedSeedLogger(): Pick<
  Console,
  "log" | "warn" | "error"
> {
  const forward =
    (sink: (message: string, ...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      sink(args.map(sanitizeSeedLogArg).join(" "));
    };
  return {
    log: forward(log.info),
    warn: forward(log.warn),
    error: forward(log.error),
  };
}

/**
 * The seed program calls `logger.error(error)` with an Error instance, not only
 * with strings, so the stack (which carries the message) is what must be
 * sanitized. A non-string, non-Error argument is stringified rather than
 * inspected — no structured value reaches the sink unredacted.
 */
function sanitizeSeedLogArg(arg: unknown): string {
  if (arg instanceof Error) {
    return sanitizeOperatorMessageFragment(
      arg.stack ?? `${arg.name}: ${arg.message}`
    );
  }
  return sanitizeOperatorMessageFragment(
    typeof arg === "string" ? arg : String(arg)
  );
}
