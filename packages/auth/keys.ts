import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_NAME_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_EMAIL_ENV,
  E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
  E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV,
} from "./auth-mode";

/**
 * ISS-10335 synthetic-identity override (ISS-12135 added the display ones).
 * Optional and non-empty:
 * `emptyStringAsUndefined` turns a compose file's unprovisioned
 * `${SEED_SANDBOX_CLERK_ORG_ID:-}` into `undefined`, which is exactly the "take
 * the fixed default" case `resolveLocalTrustedIdentity` implements. No format
 * check beyond non-empty — the value is whatever Clerk id the seed bound, and a
 * prefix rule here would reject a legitimate one.
 *
 * These grant nothing on their own. `AUTH_MODE` plus the hard non-production
 * guard still decides whether a synthetic session is served at all.
 */
const localTrustedIdentityOverride = z.string().trim().min(1).optional();

export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      AUTH_MODE: z
        .enum([AuthMode.Clerk, AuthMode.LocalTrusted])
        .default(AuthMode.Clerk)
        .optional(),
      CLERK_SECRET_KEY: z.string().startsWith("sk_").optional(),
      CLERK_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
      [E2E_LOCAL_TRUSTED_ORG_ID_ENV]: localTrustedIdentityOverride,
      [E2E_LOCAL_TRUSTED_ORG_SLUG_ENV]: localTrustedIdentityOverride,
      [E2E_LOCAL_TRUSTED_USER_ID_ENV]: localTrustedIdentityOverride,
      [E2E_LOCAL_TRUSTED_ORG_NAME_ENV]: localTrustedIdentityOverride,
      [E2E_LOCAL_TRUSTED_USER_EMAIL_ENV]: localTrustedIdentityOverride,
      [E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV]: localTrustedIdentityOverride,
      [E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV]: localTrustedIdentityOverride,
    },
    client: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
        .string()
        .startsWith("pk_")
        .optional(),
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string().startsWith("/").optional(),
      NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.string().startsWith("/").optional(),
      NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL: z
        .string()
        .startsWith("/")
        .optional(),
      NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL: z
        .string()
        .startsWith("/")
        .optional(),
      NEXT_PUBLIC_LOGO_URL: z.string().url().optional(),
    },
    runtimeEnv: {
      AUTH_MODE: process.env.AUTH_MODE,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
      [E2E_LOCAL_TRUSTED_ORG_ID_ENV]: process.env[E2E_LOCAL_TRUSTED_ORG_ID_ENV],
      [E2E_LOCAL_TRUSTED_ORG_SLUG_ENV]:
        process.env[E2E_LOCAL_TRUSTED_ORG_SLUG_ENV],
      [E2E_LOCAL_TRUSTED_USER_ID_ENV]:
        process.env[E2E_LOCAL_TRUSTED_USER_ID_ENV],
      [E2E_LOCAL_TRUSTED_ORG_NAME_ENV]:
        process.env[E2E_LOCAL_TRUSTED_ORG_NAME_ENV],
      [E2E_LOCAL_TRUSTED_USER_EMAIL_ENV]:
        process.env[E2E_LOCAL_TRUSTED_USER_EMAIL_ENV],
      [E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV]:
        process.env[E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV],
      [E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV]:
        process.env[E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV],
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
      NEXT_PUBLIC_CLERK_SIGN_UP_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL,
      NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL:
        process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL,
      NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL:
        process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL,
      NEXT_PUBLIC_LOGO_URL: process.env.NEXT_PUBLIC_LOGO_URL,
    },
  });
