import { log } from "@repo/observability/log";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL = new URL(
  "https://token.actions.githubusercontent.com/.well-known/jwks"
);
const GITHUB_OIDC_AUDIENCE = "closedloop-preview-schema-cleanup";
const GITHUB_OIDC_REPOSITORY = "closedloop-ai/symphony-alpha";
const GITHUB_OIDC_WORKFLOW_REF_PREFIX =
  "closedloop-ai/symphony-alpha/.github/workflows/cleanup-preview-schemas.yml@";

const defaultJwks = createRemoteJWKSet(GITHUB_OIDC_JWKS_URL);

const githubOidcClaimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  job_workflow_ref: z.string(),
  repository: z.string(),
});

type ValidateGitHubOidcTokenOptions = {
  jwks?: JWTVerifyGetKey;
};

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  return token || null;
}

function hasExpectedAudience(audience: string | string[]): boolean {
  return Array.isArray(audience)
    ? audience.includes(GITHUB_OIDC_AUDIENCE)
    : audience === GITHUB_OIDC_AUDIENCE;
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
 * Verifies the JWT signature against GitHub's JWKS endpoint (RS256),
 * then enforces claim constraints specific to the preview-schema cleanup
 * workflow:
 * - `iss`: must be the GitHub OIDC issuer
 * - `aud`: must be `closedloop-preview-schema-cleanup`
 * - `repository`: must be `closedloop-ai/symphony-alpha`
 * - `job_workflow_ref`: must start with the cleanup workflow file path prefix
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

  if (!hasExpectedAudience(claims.aud)) {
    return forbiddenClaimResponse("aud", claims.aud);
  }

  if (claims.repository !== GITHUB_OIDC_REPOSITORY) {
    return forbiddenClaimResponse("repository", claims.repository);
  }

  if (!claims.job_workflow_ref.startsWith(GITHUB_OIDC_WORKFLOW_REF_PREFIX)) {
    return forbiddenClaimResponse("job_workflow_ref", claims.job_workflow_ref);
  }

  return null;
};
