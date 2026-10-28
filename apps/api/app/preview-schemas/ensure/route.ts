import "server-only";

import { success } from "@repo/api/src/types/common";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { VibeEnvironmentMode } from "@repo/database/scripts/vibe-environment";
import { parseError } from "@repo/observability/error";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  GitHubOidcCaller,
  validateGitHubOidcToken,
} from "@/lib/auth/github-oidc-auth";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { errorResponse } from "@/lib/route-utils";
import { parsePreviewSchemaRequestBody } from "../request-body";
import {
  ENSURE_DEADLINE_RESERVE_MS,
  ENSURE_PUBLIC_MIGRATE_ALLOWANCE_MS,
  ENSURE_ROUTE_CEILING_MS,
  EnsureFailureReason,
  EnsureTarget,
} from "./constants";
import { ensureSchemaAtHead } from "./service";

/**
 * ISS-5983: brings ONE schema to migration head from an api-stage runtime
 * function, so the `@repo/database` build no longer has to be the only thing
 * that can reach stage RDS (PRD-576 Workstream A — a Vercel build must detach
 * from Secure Compute, a runtime function keeps the static IPs).
 *
 * This route is a CALLER, not a second pipeline: the service hands the same IAM
 * URL to the same `runMigrationPipeline`, so the P1002 serialize gate, the
 * FEA-3071 at-head probe and the ISS-5285 token re-mint are the ones already in
 * production.
 *
 * ISS-5984 added `target`. `preview` (the default, and what an omitting caller
 * still gets) derives the branch's `preview_*` schema; `public` migrates the
 * stage `public` schema, which is the half `PLN-1629`'s finding F1 showed the
 * build would otherwise strand. The `public` request comes from the stage-deploy
 * workflow AFTER the api-stage deployment is READY — the deliberate ordering
 * flip accepted as PRD-576 D2, which obliges migration authors to the
 * expand/contract discipline in
 * `docs/runbooks/backward-compatible-api-contracts.md`.
 *
 * ## Auth: GitHub OIDC, converged with the sibling route (ISS-5984)
 *
 * ISS-5983 shipped `validateInternalSecret` here, per its ticket's literal
 * wording, and flagged that the sibling `/preview-schemas` route uses GitHub
 * OIDC. This route now uses OIDC too. Two adjacent routes on two schemes is how
 * one gets hardened later and the other does not, and OIDC is the stronger of
 * the pair: a short-lived, claim-bound token rather than a long-lived shared
 * secret, with the caller pinned to one workflow file. It also needs no secret
 * provisioned into CI, which `validateInternalSecret` would have (nothing in
 * `.github/` holds `INTERNAL_API_SECRET` today). Safe to switch outright rather
 * than accept both: this route is days old and has no caller in any deployed
 * environment, so there is no version-skewed client to keep working.
 *
 * ## Non-prod enforcement (ISS-6403, Finding 2)
 *
 * "an api-stage runtime function" above is now a RUNTIME CHECK, not a comment —
 * but the check is NOT here. It lives in `ensureSchemaAtHead`, before any URL is
 * minted, so the lazy `ensurePreviewSchemaBootstrap` gate (which imports that
 * function directly and never reaches this route) inherits it too. All this
 * route owns is the status code: a `HostNotAllowed` refusal answers 403.
 * See the service for why the check is on the HOST rather than on a deployment
 * label, and why it fails closed.
 */

/** The 5-minute serverless ceiling; a first bootstrap runs migrate + data clone. */
export const maxDuration = 300;

const ensureRequestValidator = z.object({
  branch: repoBranchSchema,
  /**
   * Omitted means `preview`. Additive and optional so a caller written against
   * the ISS-5983 contract keeps its exact behavior.
   */
  target: z.enum([EnsureTarget.Preview, EnsureTarget.Public]).optional(),
  /**
   * ISS-12056: build the branch's preview schema as an EMPTY vibe environment
   * of this mode instead of a clone of `public`. Sent only by
   * `vibe-environment.yml`; omitted, the route behaves exactly as before.
   */
  vibeEnvironment: z
    .enum([VibeEnvironmentMode.Seeded, VibeEnvironmentMode.Blank])
    .optional(),
});

/**
 * `null` is the migration pipeline's own representation of `public`, and the
 * value `resolveSchemaName` hands the build on the production target — so the
 * `public` request takes the identical path the build takes today.
 */
function resolveTargetSchema(
  branch: string,
  target: EnsureTarget | undefined
): string | null {
  return target === EnsureTarget.Public
    ? null
    : deriveBranchSchemaName(branch, normalizePreviewSchemaName);
}

async function handlePost(request: NextRequest): Promise<Response> {
  // ISS-6403 Finding 1: the PLATFORM's clock starts here, so the budget has to
  // as well. On a cold instance the OIDC validation below fetches GitHub's
  // remote JWKS and the service signs an RDS IAM token through STS — seconds of
  // network before the pipeline is even entered. Charging those to the deadline
  // rather than to the reserve is what keeps the 504 landing INSIDE the 300s
  // ceiling instead of just after it (review).
  const startedAt = Date.now();
  try {
    const authError = await validateGitHubOidcToken(request, {
      caller: GitHubOidcCaller.PreviewSchemaEnsure,
    });
    if (authError) {
      return authError;
    }

    const { body, errorResponse: parseErrorResponse } =
      await parsePreviewSchemaRequestBody(request, ensureRequestValidator);
    if (parseErrorResponse) {
      return parseErrorResponse;
    }

    const { branch, target, vibeEnvironment } = body;
    if (vibeEnvironment !== undefined && target === EnsureTarget.Public) {
      return errorResponse(
        "A vibe environment is a branch preview schema; it cannot target public",
        null,
        400
      );
    }
    const schema = resolveTargetSchema(branch, target);
    // ISS-6403 Finding 1: THIS route's ceiling, supplied by the route that
    // declares it. The pipeline's internal budgets all meet or exceed 300s and
    // its `prisma migrate deploy` spawn has no timeout at all, so a long run
    // was killed by the platform mid-step — the `catch` below never ran and the
    // caller got a `FUNCTION_INVOCATION_TIMEOUT` instead of this envelope.
    //
    // NOT `serializeBudgetMs`, the seam the pipeline already exposes: that
    // number becomes the FEA-3065 gate's `statement_timeout`, and the gate FAILS
    // OPEN, so shortening it makes the gate give up early and then start an
    // UNGUARDED migrate with almost none of the ceiling left — risking a P3009
    // failed-migration state on stage. It also cannot reach the spawned CLI.
    // Being cut while still queued is not harmless either: the waiter outlives
    // its 504 and fails open later (ISS-11781 measured gate waits of 465-476s).
    const budgetMs = Math.max(
      1,
      ENSURE_ROUTE_CEILING_MS -
        ENSURE_DEADLINE_RESERVE_MS -
        (Date.now() - startedAt)
    );
    // ISS-11781: so `public` gets its own, shorter gate budget that fails
    // CLOSED, which a short budget can do safely. A preview ensure keeps the
    // fail-open gate it has always had.
    const result = await ensureSchemaAtHead(branch, schema, {
      budgetMs,
      ...(target === EnsureTarget.Public
        ? {
            gateBudgetMs: Math.max(
              1,
              budgetMs - ENSURE_PUBLIC_MIGRATE_ALLOWANCE_MS
            ),
          }
        : {}),
      ...(vibeEnvironment === undefined ? {} : { vibeEnvironment }),
    });

    if (!result.ok) {
      // The service owns the host invariant (every caller inherits it); this
      // route owns only how a refusal reads over HTTP. `result.message` is
      // already the generic, hostname-free text — see `HOST_REFUSED_MESSAGE`.
      return errorResponse(
        result.message,
        null,
        statusForFailure(result.reason)
      );
    }

    if (
      vibeEnvironment !== undefined &&
      result.vibeEnvironment?.mode !== vibeEnvironment
    ) {
      // The schema was ensured but did not come back marked, so the workflow
      // must not seed it as one.
      return errorResponse(
        `Schema "${result.schema}" was ensured but is not marked as a ${vibeEnvironment} vibe environment`,
        null,
        500
      );
    }

    const { ok, ...ensured } = result;
    return NextResponse.json(success(ensured));
  } catch (error) {
    // Preconditions above can throw — a rejected schema derivation, an AWS
    // signer built from malformed IAM config, a filesystem error inside the
    // layout probe. This route owns a JSON error envelope, so it answers in that
    // envelope rather than leaking an unhandled 500 (apps/api/AGENTS.md).
    // Sanitized, not suppressed: the staging workflow echoes this body into a
    // GitHub Actions log, and the IAM signer this can throw from is built from
    // a credential-bearing URL. ISS-6558 put the diagnosis text here on
    // purpose, so it is redacted rather than replaced (ISS-7567).
    return errorResponse(
      `Failed to ensure a schema: ${sanitizeOperatorMessageFragment(parseError(error))}`,
      null,
      500
    );
  }
}

/**
 * How each refusal reads over HTTP. The service owns WHY it refused; this owns
 * only the status. An exhaustive `Record`, not a chain of comparisons, so a new
 * `EnsureFailureReason` fails typecheck until it is given a status rather than
 * defaulting into 500 (AGENTS.md: closed-union mappers keep an exhaustive guard).
 *
 * ISS-6403 Finding 1: a deadline expiry is a 504, not a 500. The migrate is
 * still running when this answers, so the honest statement is "no answer within
 * the deadline", not "the migration failed" — and the two want opposite
 * responses from a caller, since retrying a still-running migrate behind a
 * preview's fail-open gate starts a second one on the same schema.
 */
const FAILURE_STATUS: Record<EnsureFailureReason, number> = {
  [EnsureFailureReason.HostNotAllowed]: 403,
  [EnsureFailureReason.TimedOut]: 504,
  [EnsureFailureReason.Failed]: 500,
  // ISS-11781: nothing ran, so the caller may retry — which `migrate-public`
  // in staging-integration-tests.yml does, and does not do for a 500.
  [EnsureFailureReason.Contended]: 503,
};

function statusForFailure(reason: EnsureFailureReason): number {
  return FAILURE_STATUS[reason];
}

export const POST = withRequestCompleted(handlePost);
