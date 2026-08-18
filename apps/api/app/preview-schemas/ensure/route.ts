import "server-only";

import { success } from "@repo/api/src/types/common";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { parseError } from "@repo/observability/error";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  GitHubOidcCaller,
  validateGitHubOidcToken,
} from "@/lib/auth/github-oidc-auth";
import { errorResponse, parseBody, scheduleLogFlush } from "@/lib/route-utils";
import { EnsureFailureReason, EnsureTarget } from "./constants";
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
  branch: z.string().min(1),
  /**
   * Omitted means `preview`. Additive and optional so a caller written against
   * the ISS-5983 contract keeps its exact behavior.
   */
  target: z.enum([EnsureTarget.Preview, EnsureTarget.Public]).optional(),
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

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const authError = await validateGitHubOidcToken(request, {
      caller: GitHubOidcCaller.PreviewSchemaEnsure,
    });
    if (authError) {
      return authError;
    }

    const { body, errorResponse: parseErrorResponse } = await parseBody(
      request,
      ensureRequestValidator
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }

    const { branch, target } = body;
    const schema = resolveTargetSchema(branch, target);
    const result = await ensureSchemaAtHead(branch, schema);

    if (!result.ok) {
      // The service owns the host invariant (every caller inherits it); this
      // route owns only how a refusal reads over HTTP. `result.message` is
      // already the generic, hostname-free text — see `HOST_REFUSED_MESSAGE`.
      const status =
        result.reason === EnsureFailureReason.HostNotAllowed ? 403 : 500;
      return errorResponse(result.message, null, status);
    }

    const { ok, ...ensured } = result;
    return NextResponse.json(success(ensured));
  } catch (error) {
    // Preconditions above can throw — a rejected schema derivation, an AWS
    // signer built from malformed IAM config, a filesystem error inside the
    // layout probe. This route owns a JSON error envelope, so it answers in that
    // envelope rather than leaking an unhandled 500 (apps/api/AGENTS.md).
    return errorResponse(
      `Failed to ensure a schema: ${parseError(error)}`,
      null,
      500
    );
  } finally {
    scheduleLogFlush();
  }
}
