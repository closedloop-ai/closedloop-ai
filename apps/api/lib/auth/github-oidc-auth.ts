import { FEATURE_FLAG_SNAPSHOT_OIDC_AUDIENCE } from "@repo/api/src/types/feature-flag-snapshot";
import { log } from "@repo/observability/log";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL = new URL(
  "https://token.actions.githubusercontent.com/.well-known/jwks"
);
const GITHUB_OIDC_REPOSITORY = "closedloop-ai/closedloop-ai";
/** The only ref whose runs may mint a token for an IAM-backed mutating route. */
const TRUSTED_REF = "refs/heads/main";

/** `job_workflow_ref` is `<repo>/<workflow path>@<ref>`. */
function workflowPath(workflowFile: string): string {
  return `${GITHUB_OIDC_REPOSITORY}/.github/workflows/${workflowFile}`;
}

function trustedMainWorkflowRef(workflowFile: string): string {
  return `${workflowPath(workflowFile)}@${TRUSTED_REF}`;
}

/**
 * The callers allowed to authenticate with a GitHub OIDC token, each pinned to
 * its OWN audience and its OWN workflow file. Keeping them separate is the point
 * of the mechanism: a token minted for the cleanup sweep cannot be replayed
 * against the ensure endpoint, and neither can be minted by a third workflow.
 *
 * A caller declares its trusted refs one of two ways, and the difference is the
 * security boundary rather than a style choice:
 *
 * - `workflowRefs` — an allowlist of FULL `job_workflow_ref` values, matched by
 *   exact equality. This is the default and what any IAM-backed mutating route
 *   must use.
 * - `anyRefWorkflowPrefix` — the workflow file, any ref. A deliberate, narrow
 *   exception; see `PreviewSchemaCleanup`.
 *
 * ISS-5984 added `PreviewSchemaEnsure` and converged `/preview-schemas/ensure`
 * onto this scheme; see that route's header for why, over the internal secret
 * ISS-5983 shipped.
 */
export const GitHubOidcCaller = {
  /**
   * The one ref-agnostic caller. `cleanup-preview-schemas.yml` is a
   * `workflow_dispatch`-only operator entry point that is deliberately runnable
   * from a feature branch so a change to the sweep can be tested against stage
   * before it lands — that workflow's own job comment states the same intent.
   * Pinning it to `main` would remove that capability, so it stays ref-agnostic
   * until someone decides otherwise.
   */
  PreviewSchemaCleanup: {
    audience: "closedloop-preview-schema-cleanup",
    anyRefWorkflowPrefix: `${workflowPath("cleanup-preview-schemas.yml")}@`,
  },
  /**
   * ISS-10058: `api-ecs-preview.yml` ensures the schema of an api-ecs preview,
   * which the Vercel deployment-success dispatch never reaches. It runs on
   * `workflow_run`, so GitHub loads it from `main` only.
   *
   * ISS-12056: `vibe-environment.yml` (main, on `workflow_run`) builds a vibe
   * environment's schema through this same route, the one place a preview
   * schema is migrated from a function.
   */
  PreviewSchemaEnsure: {
    audience: "closedloop-preview-schema-ensure",
    workflowRefs: [
      trustedMainWorkflowRef("staging-integration-tests.yml"),
      trustedMainWorkflowRef("api-ecs-preview.yml"),
      trustedMainWorkflowRef("vibe-environment.yml"),
    ],
  },
  /**
   * ISS-6804: `/preview-schemas/seed`, called by the same workflow right after
   * the ensure. Its own audience so an ensure token cannot seed and a seed token
   * cannot migrate — the two mutate the same schema at different blast radii.
   */
  PreviewSchemaSeed: {
    audience: "closedloop-preview-schema-seed",
    workflowRefs: [trustedMainWorkflowRef("staging-integration-tests.yml")],
  },
  /**
   * ISS-12056: the `/preview-schemas/vibe-environment/*` routes, called only by
   * `vibe-environment.yml`, which runs from `main` on the `workflow_run` of its
   * permission-less dispatch half. Its own audience: these routes load seeded
   * rows and transcripts into a vibe environment, which neither the ensure nor
   * the seed token may do.
   */
  PreviewSchemaVibeEnvironment: {
    audience: "closedloop-preview-schema-vibe-environment",
    workflowRefs: [trustedMainWorkflowRef("vibe-environment.yml")],
  },
  /**
   * ISS-12048: `/preview-schemas/feature-flag-snapshot`, called by the `$vibe`
   * environment workflow (ISS-12056) once it has taken the production flag
   * snapshot. Its own audience, so a seed or ensure token cannot pin flags and
   * a snapshot token cannot seed or migrate.
   */
  PreviewSchemaFeatureFlagSnapshot: {
    audience: FEATURE_FLAG_SNAPSHOT_OIDC_AUDIENCE,
    workflowRefs: [trustedMainWorkflowRef("vibe-environment.yml")],
  },
  /**
   * ISS-12216: the read-only `/preview-schemas/vibe-inventory` route, called
   * by `prototype-pin-alias.yml` on the `delete` event and its weekly
   * schedule, both of which run the default branch's workflow file. The script
   * keeps a copy of this audience (`scripts/ci/prototype-pin-alias.ts`).
   */
  PreviewSchemaVibeInventory: {
    audience: "closedloop-preview-schema-vibe-inventory",
    workflowRefs: [trustedMainWorkflowRef("prototype-pin-alias.yml")],
  },
  /**
   * ISS-11782/ISS-11783: the read-only `/preview-schemas/applied-migrations`
   * route. `deploy-production.yml` reads it before promoting `production`, and
   * `stage-migrated-ref.yml` (a reusable workflow, so its own file is the
   * `job_workflow_ref` even when `green-ref.yml` or
   * `stage-migrated-wake.yml` call it) reads it before moving the
   * `stage-migrated` ref. Its own audience, so an ensure token cannot read the
   * list and neither reader's token can migrate.
   */
  PreviewSchemaAppliedMigrations: {
    audience: "closedloop-preview-schema-applied-migrations",
    workflowRefs: [
      trustedMainWorkflowRef("deploy-production.yml"),
      trustedMainWorkflowRef("stage-migrated-ref.yml"),
    ],
  },
} as const;

export type GitHubOidcCallerConfig =
  (typeof GitHubOidcCaller)[keyof typeof GitHubOidcCaller];

const defaultJwks = createRemoteJWKSet(GITHUB_OIDC_JWKS_URL);

const githubOidcClaimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  job_workflow_ref: z.string(),
  repository: z.string(),
});

type ValidateGitHubOidcTokenOptions = {
  jwks?: JWTVerifyGetKey;
  /** Defaults to the cleanup sweep, the caller this module shipped for. */
  caller?: GitHubOidcCallerConfig;
};

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  return token || null;
}

function hasExpectedAudience(
  audience: string | string[],
  expected: string
): boolean {
  return Array.isArray(audience)
    ? audience.includes(expected)
    : audience === expected;
}

/**
 * ISS-6804 (review: davetho). Exact equality against the caller's allowlist,
 * never a prefix: `job_workflow_ref` ends in `@<ref>`, so a prefix match on the
 * path accepts the workflow run from ANY ref — and `workflow_dispatch` can run a
 * contributor-controlled one. A prefix on the full ref is no better: it would
 * also accept `@refs/heads/main-anything`.
 */
function isTrustedWorkflowRef(
  caller: GitHubOidcCallerConfig,
  jobWorkflowRef: string
): boolean {
  if ("workflowRefs" in caller) {
    const trusted: readonly string[] = caller.workflowRefs;
    return trusted.includes(jobWorkflowRef);
  }
  return jobWorkflowRef.startsWith(caller.anyRefWorkflowPrefix);
}

function forbiddenClaimResponse(
  claim: "aud" | "job_workflow_ref" | "repository",
  received: unknown
): Response {
  log.warn("[github-oidc-auth] token claim check failed", {
    claim,
    received,
  });
  return new Response("Forbidden", { status: 403 });
}

/**
 * Validates a GitHub OIDC `Authorization: Bearer <token>` header.
 *
 * Verifies the JWT signature against GitHub's JWKS endpoint (RS256), then
 * enforces claim constraints specific to ONE caller from `GitHubOidcCaller`:
 * - `iss`: must be the GitHub OIDC issuer
 * - `aud`: must be that caller's audience
 * - `repository`: must be `closedloop-ai/closedloop-ai`
 * - `job_workflow_ref`: must be one of that caller's trusted full refs (exact),
 *   or, for a ref-agnostic caller, that caller's workflow file on any ref
 *
 * Returns `null` when the request is authorized and the route should proceed.
 * Returns a `Response` to short-circuit on failure:
 * - 401 for missing/malformed/expired/invalid-signature tokens
 * - 403 for well-formed tokens that fail claim checks
 *
 * The `jwks` option is injectable for testing with a local key set.
 */
export const validateGitHubOidcToken = async (
  request: Request,
  opts?: ValidateGitHubOidcTokenOptions
): Promise<Response | null> => {
  const caller = opts?.caller ?? GitHubOidcCaller.PreviewSchemaCleanup;
  const token = extractBearerToken(request);
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  const jwks = opts?.jwks ?? defaultJwks;

  let claims: z.infer<typeof githubOidcClaimsSchema>;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: GITHUB_OIDC_ISSUER,
      algorithms: ["RS256"],
    });

    const parseResult = githubOidcClaimsSchema.safeParse(result.payload);
    if (!parseResult.success) {
      const claim = parseResult.error.issues[0]?.path[0];
      return forbiddenClaimResponse(
        claim === "aud" ||
          claim === "job_workflow_ref" ||
          claim === "repository"
          ? claim
          : "repository",
        null
      );
    }
    claims = parseResult.data;
  } catch (err) {
    log.warn("[github-oidc-auth] token verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  if (!hasExpectedAudience(claims.aud, caller.audience)) {
    return forbiddenClaimResponse("aud", claims.aud);
  }

  if (claims.repository !== GITHUB_OIDC_REPOSITORY) {
    return forbiddenClaimResponse("repository", claims.repository);
  }

  if (!isTrustedWorkflowRef(caller, claims.job_workflow_ref)) {
    return forbiddenClaimResponse("job_workflow_ref", claims.job_workflow_ref);
  }

  return null;
};
