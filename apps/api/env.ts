import { createPrivateKey, type KeyObject } from "node:crypto";
import { keys as ai } from "@repo/ai/keys";
import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as collaboration } from "@repo/collaboration/server/keys";
import { keys as database } from "@repo/database/keys";
import { keys as email } from "@repo/email/keys";
import { keys as google } from "@repo/google/keys";
import { keys as linear } from "@repo/linear/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { keys as pensero } from "@repo/pensero/keys";
import { assumedRoleArnPrefix } from "@repo/realtime-contract/doc-sync-internal";
import { isRealtimeOnlyOidcAudience } from "@repo/realtime-contract/internal";
import { realtimeServiceUrlSchema } from "@repo/realtime-contract/protocol";
import {
  parseRealtimeTokenKmsKeyArn,
  REALTIME_TOKEN_KID,
  type RealtimeTokenKmsKey,
} from "@repo/realtime-contract/token";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// Note: @repo/github and @repo/aws keys are validated at runtime (not build time)
// because they're optional integrations. See isGitHubConfigured() / isS3Configured().
// @repo/linear keys are now optional and extended here.

const HTTP_PROTOCOL = /^https?$/;
const HTTPS_PROTOCOL = /^https$/;
const IAM_ROLE_ARN = /^arn:aws[\w-]*:iam::\d{12}:role\/.+$/;
// Read while `env` below is built, so it cannot sit at the bottom of the file.
const VERCEL_PRODUCTION_ENV = "production";

const coreEnv = core();

export const env = createEnv({
  emptyStringAsUndefined: true,
  extends: [
    ai(),
    auth(),
    analytics(),
    collaboration(),
    coreEnv,
    database(),
    email(),
    google(),
    linear(),
    observability(),
    pensero(),
  ],
  server: {
    /**
     * ISS-9164: comma-separated `ComputeTarget.id`s served the internal desktop
     * release ring, and (PRD-707 O2) how an opted-in external design partner
     * joins it. Entries are trimmed, so a list wrapped across a `.env` line still
     * matches. Unset means nobody is allow-listed individually.
     */
    DESKTOP_INTERNAL_RING_TARGETS: z.string().optional(),
    /**
     * ISS-9164: comma-separated `Organization.id`s whose every compute target is
     * in the internal ring — in production, ClosedLoop's own organisation.
     *
     * Configured rather than hardcoded because nothing in this repo identifies
     * "the ClosedLoop organisation": there is no `Organization.isInternal` column,
     * no slug constant, and no existing env var, so the alternative was a literal
     * UUID or slug that a rename would silently turn into an internal ring nobody
     * is in.
     */
    DESKTOP_INTERNAL_RING_ORGANIZATIONS: z.string().optional(),

    DESKTOP_OTLP_COLLECTOR_URL: z.url({ protocol: HTTPS_PROTOCOL }).optional(),
    /**
     * ISS-12211: the audience of the Vercel OIDC token the route sends to the
     * Collector ingress, whose load balancer checks it. Never Vercel's default
     * audience, which AWS STS trusts.
     */
    DESKTOP_OTLP_COLLECTOR_OIDC_AUDIENCE: z
      .string()
      .min(1)
      .refine(isRealtimeOnlyOidcAudience, {
        message:
          "DESKTOP_OTLP_COLLECTOR_OIDC_AUDIENCE must not be Vercel's default audience",
      })
      .optional(),
    INTERNAL_API_SECRET: z.string().min(1).optional(),
    /**
     * ISS-11966 (Perrin Upcott, 2026-10-09): an RSA private JWK with a `kid`
     * that signs realtime grant tokens RS256 where KMS does not, in local dev
     * and e2e. Refused on Vercel production and on ECS. Unused once
     * `REALTIME_TOKEN_KMS_KEY_ID` is set; with neither, `POST /realtime/token`
     * answers 503.
     */
    REALTIME_TOKEN_LOCAL_PRIVATE_KEY: z
      .string()
      .transform((value, ctx): RealtimeTokenLocalKey => {
        const key = parseRealtimeTokenLocalKey(value);
        if (key) {
          return key;
        }
        ctx.addIssue({
          code: "custom",
          message:
            "REALTIME_TOKEN_LOCAL_PRIVATE_KEY must be an RSA private JWK whose kid is a bare KMS key ID",
        });
        return z.NEVER;
      })
      .optional(),
    /**
     * ISS-11966 item 1: the ARN of the KMS key that signs realtime grant
     * tokens with RS256, read into its region and `kid`. A bare key ID is
     * refused: it names no region, so the signer would follow the function's
     * own. Set, `POST /realtime/token` signs only through KMS and never falls
     * back to `REALTIME_TOKEN_LOCAL_PRIVATE_KEY`.
     */
    REALTIME_TOKEN_KMS_KEY_ID: z
      .string()
      .transform((value, ctx): RealtimeTokenKmsKey => {
        const key = parseRealtimeTokenKmsKeyArn(value);
        if (key) {
          return key;
        }
        ctx.addIssue({
          code: "custom",
          message:
            "REALTIME_TOKEN_KMS_KEY_ID must be a KMS key ARN (arn:aws:kms:<region>:<account>:key/<key-id>)",
        });
        return z.NEVER;
      })
      .optional(),
    /**
     * ISS-11827: the role apps/api assumes through Vercel OIDC to call
     * `kms:Sign`. On ECS the task role signs and this role is not assumed
     * (ISS-12365); the pair rule below still requires it.
     */
    REALTIME_TOKEN_SIGNER_ROLE_ARN: z
      .string()
      .regex(IAM_ROLE_ARN, {
        message: "REALTIME_TOKEN_SIGNER_ROLE_ARN must be an IAM role ARN",
      })
      .optional(),
    /**
     * PLN-2200 T-7.7 (Q-001 default A): the doc-sync task role. `POST
     * /doc-sync/changes` accepts only a caller STS identifies as a session of
     * this role, and answers 503 while it is unset. Checked with the parse the
     * route matches callers by, so a value it cannot match (a trailing slash)
     * fails here instead of refusing every callback.
     */
    DOC_SYNC_CALLBACK_ROLE_ARN: z
      .string()
      .refine((roleArn) => assumedRoleArnPrefix(roleArn) !== undefined, {
        message: "DOC_SYNC_CALLBACK_ROLE_ARN must be an IAM role ARN",
      })
      .optional(),
    /** ISS-11210 requirement 10: base URL of the realtime service's internal publish and revoke endpoints (PLN-2105). */
    REALTIME_INTERNAL_URL: z.url({ protocol: HTTP_PROTOCOL }).optional(),
    /**
     * ISS-11966 item 2: the audience of the Vercel OIDC token sent as the
     * bearer on internal calls; the realtime service expects the same value.
     * Never Vercel's default audience, which AWS STS trusts.
     */
    REALTIME_INTERNAL_OIDC_AUDIENCE: z
      .string()
      .min(1)
      .refine(isRealtimeOnlyOidcAudience, {
        message:
          "REALTIME_INTERNAL_OIDC_AUDIENCE must not be Vercel's default audience",
      })
      .optional(),
    /**
     * ISS-11210 requirement 10: the public socket URL `POST /realtime/token`
     * hands to clients (ask 3), so installed desktop builds follow the host.
     */
    REALTIME_PUBLIC_URL: realtimeServiceUrlSchema.optional(),
    /**
     * PLN-2099 E4: the document sync service URL `POST /doc-sync/token` hands
     * to clients. Unset answers that route 503.
     */
    DOC_SYNC_PUBLIC_URL: realtimeServiceUrlSchema.optional(),
    /** PLN-2200 T-5.3: base URL of the document sync service's internal commands. Unset makes every call a no-op. */
    DOC_SYNC_INTERNAL_URL: z.url({ protocol: HTTP_PROTOCOL }).optional(),
    /**
     * PLN-2200 T-5.3: the audience of the Vercel OIDC bearer on doc-sync's
     * internal calls; the service expects the same value. Never Vercel's
     * default audience, which AWS STS trusts.
     */
    DOC_SYNC_INTERNAL_OIDC_AUDIENCE: z
      .string()
      .min(1)
      .refine(isRealtimeOnlyOidcAudience, {
        message:
          "DOC_SYNC_INTERNAL_OIDC_AUDIENCE must not be Vercel's default audience",
      })
      .optional(),
    RELAY_API_URL: z.url().optional(),
    SLACK_BOT_TOKEN: z.string().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
  },
  client: {},
  // The per-key schemas cannot see each other; a cross-key rule goes here.
  createFinalSchema: (shape) =>
    z
      .object(shape)
      .superRefine(requireRealtimeTokenKmsPair)
      .superRefine(refuseLocalTokenKeyOutsideDevAndE2e),
  runtimeEnv: {
    DESKTOP_INTERNAL_RING_ORGANIZATIONS:
      process.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS,
    DESKTOP_INTERNAL_RING_TARGETS: process.env.DESKTOP_INTERNAL_RING_TARGETS,
    DESKTOP_OTLP_COLLECTOR_OIDC_AUDIENCE:
      process.env.DESKTOP_OTLP_COLLECTOR_OIDC_AUDIENCE,
    DESKTOP_OTLP_COLLECTOR_URL: process.env.DESKTOP_OTLP_COLLECTOR_URL,
    DOC_SYNC_CALLBACK_ROLE_ARN: process.env.DOC_SYNC_CALLBACK_ROLE_ARN,
    DOC_SYNC_INTERNAL_OIDC_AUDIENCE:
      process.env.DOC_SYNC_INTERNAL_OIDC_AUDIENCE,
    DOC_SYNC_INTERNAL_URL: process.env.DOC_SYNC_INTERNAL_URL,
    DOC_SYNC_PUBLIC_URL: process.env.DOC_SYNC_PUBLIC_URL,
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
    REALTIME_INTERNAL_OIDC_AUDIENCE:
      process.env.REALTIME_INTERNAL_OIDC_AUDIENCE,
    REALTIME_INTERNAL_URL: process.env.REALTIME_INTERNAL_URL,
    REALTIME_PUBLIC_URL: process.env.REALTIME_PUBLIC_URL,
    REALTIME_TOKEN_KMS_KEY_ID: process.env.REALTIME_TOKEN_KMS_KEY_ID,
    REALTIME_TOKEN_LOCAL_PRIVATE_KEY:
      process.env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY,
    REALTIME_TOKEN_SIGNER_ROLE_ARN: process.env.REALTIME_TOKEN_SIGNER_ROLE_ARN,
    RELAY_API_URL: process.env.RELAY_API_URL,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  },
});

/**
 * Perrin Upcott, 2026-10-05 (ISS-11966): the KMS key and the signer role are
 * set together or not at all. A half-set pair fails env validation, so the
 * build fails (next.config.ts imports this module) and the deployed api keeps
 * serving.
 */
function requireRealtimeTokenKmsPair(
  values: {
    REALTIME_TOKEN_KMS_KEY_ID?: RealtimeTokenKmsKey;
    REALTIME_TOKEN_SIGNER_ROLE_ARN?: string;
  },
  ctx: z.RefinementCtx
): void {
  const hasKey = values.REALTIME_TOKEN_KMS_KEY_ID !== undefined;
  const hasRole = values.REALTIME_TOKEN_SIGNER_ROLE_ARN !== undefined;
  if (hasKey && !hasRole) {
    ctx.addIssue({
      code: "custom",
      path: ["REALTIME_TOKEN_SIGNER_ROLE_ARN"],
      message:
        "REALTIME_TOKEN_SIGNER_ROLE_ARN is required when REALTIME_TOKEN_KMS_KEY_ID is set",
    });
  }
  if (hasRole && !hasKey) {
    ctx.addIssue({
      code: "custom",
      path: ["REALTIME_TOKEN_KMS_KEY_ID"],
      message:
        "REALTIME_TOKEN_KMS_KEY_ID is required when REALTIME_TOKEN_SIGNER_ROLE_ARN is set",
    });
  }
}

/**
 * Perrin Upcott, 2026-10-09 (ISS-11966): the local signing key is for local dev
 * and e2e only. It is refused on Vercel production and, per the ruling "Also
 * refuse on ECS", on ECS, where the api sets no VERCEL_ENV. On Vercel a refusal
 * fails the build and the deployed api keeps serving. The ECS image builds off
 * ECS, so there it fails the task's start: `app.prepare()` loads next.config.ts,
 * which imports this module.
 */
function refuseLocalTokenKeyOutsideDevAndE2e(
  values: { REALTIME_TOKEN_LOCAL_PRIVATE_KEY?: RealtimeTokenLocalKey },
  ctx: z.RefinementCtx
): void {
  if (
    values.REALTIME_TOKEN_LOCAL_PRIVATE_KEY !== undefined &&
    (coreEnv.VERCEL_ENV === VERCEL_PRODUCTION_ENV || runsOnEcs())
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["REALTIME_TOKEN_LOCAL_PRIVATE_KEY"],
      message:
        "REALTIME_TOKEN_LOCAL_PRIVATE_KEY is refused on Vercel production and on ECS; it signs realtime tokens in local dev and e2e only",
    });
  }
}

/**
 * ISS-11966 (Perrin Upcott, 2026-10-09): the key local dev and e2e sign grant
 * tokens with, RS256 as KMS signs elsewhere. Its `kid` keys the public half in
 * apps/realtime's `REALTIME_TOKEN_PUBLIC_KEYS`.
 */
export type RealtimeTokenLocalKey = { kid: string; privateKey: KeyObject };

/**
 * An RSA private JWK whose `kid` has the bare KMS key ID form
 * `REALTIME_TOKEN_PUBLIC_KEYS` is keyed by; anything else, a public JWK among
 * them, returns undefined. It lives here, not beside the signer: next.config.ts
 * loads this file through Next's config transpiler, which rewrites a `@repo/*`
 * path alias into a path relative to apps/api, so a module deeper in the tree
 * that imports one fails `next typegen`.
 */
function parseRealtimeTokenLocalKey(
  value: string
): RealtimeTokenLocalKey | undefined {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return undefined;
  }
  const jwk = z
    .looseObject({
      kty: z.literal("RSA"),
      kid: z.string().regex(REALTIME_TOKEN_KID),
    })
    .safeParse(json);
  if (!jwk.success) {
    return undefined;
  }
  try {
    return {
      kid: jwk.data.kid,
      privateKey: createPrivateKey({ key: jwk.data, format: "jwk" }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether this process runs as an ECS task. ECS injects
 * `ECS_CONTAINER_METADATA_URI_V4` into every container (Fargate platform
 * 1.4.0+, EC2 container agent 1.39.0+); the api sets no VERCEL_ENV there.
 */
export function runsOnEcs(): boolean {
  return Boolean(process.env.ECS_CONTAINER_METADATA_URI_V4);
}
