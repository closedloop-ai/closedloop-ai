import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/** Loopback hosts allowed to use plaintext http:// for local development. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Require an https:// base URL so the secret-bearing `Authorization: Token`
 * header is never sent in cleartext. Plaintext http:// is permitted only for
 * loopback origins (local development / self-hosted on the same host).
 */
function isSecureOrLoopbackHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Pensero integration keys (FEA-4174 / PRD-545 — Value Numerator 2.0).
 *
 * Pensero is an optional, server-side-only integration that powers the
 * Value Numerator 2.0 delivery-metrics normalization. The credential is a
 * single DRF `TokenAuth` token of the shape `tk_<public>:sk_<secret>` sent as
 * an `Authorization: Token <token>` header (see `pensero-client.ts`).
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
