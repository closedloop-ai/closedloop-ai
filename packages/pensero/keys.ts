import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { isSecureOrLoopbackHttpUrl } from "./credential";

/**
 * Pensero integration keys (FEA-4174 / PRD-545 — Value Numerator 2.0).
 *
 * Pensero is an optional, server-side-only integration that feeds the
 * delivery-points lane (`delivery-client.ts`, ISS-8399). The credential is a
 * single token of the shape `tk_<public>:sk_<secret>` that `delivery-client.ts`
 * sends as an `X-Auth-Token` header.
 *
 * SECURITY: the token embeds a secret half (`sk_...`). It is validated and
 * consumed ONLY on the server and MUST NOT be exposed to the browser bundle —
 * hence it is a `server` key with no `NEXT_PUBLIC_` prefix. It is optional so
 * the workspace validates without the integration configured; the client
 * throws a clear error at call time when it is missing.
 *
 * - PENSERO_API_TOKEN: the `tk_...:sk_...` credential (server only, secret).
 * - PENSERO_API_BASE_URL: optional base-URL override (defaults to the
 *   production Pensero API); useful for staging/self-hosted deployments.
 *
 * ISS-8007: these remain the DEPLOYMENT-WIDE DEFAULT. A per-org credential
 * configured on the Integrations screen takes precedence over them; see
 * `resolvePenseroCredential` in `./credential` for the rule and its rationale.
 */
export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      PENSERO_API_TOKEN: z.string().min(1).optional(),
      PENSERO_API_BASE_URL: z
        .string()
        .url()
        .refine(isSecureOrLoopbackHttpUrl, {
          message:
            "PENSERO_API_BASE_URL must use https:// (http:// is allowed only for loopback hosts), so the secret-bearing Authorization header is never sent in cleartext.",
        })
        .optional(),
    },
    runtimeEnv: {
      PENSERO_API_TOKEN: process.env.PENSERO_API_TOKEN,
      PENSERO_API_BASE_URL: process.env.PENSERO_API_BASE_URL,
    },
  });
