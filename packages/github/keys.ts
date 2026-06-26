import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// Top-level regex for performance
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

/**
 * Server-side GitHub keys - NOT extended via createEnv in apps.
 * These are validated at runtime via isGitHubConfigured() because
 * GitHub is an optional integration.
 */
export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      GITHUB_APP_ID: z.string().min(1),
      GITHUB_APP_PRIVATE_KEY: z.string().min(1),
      GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
      GITHUB_APP_CLIENT_ID: z.string().min(1),
      GITHUB_APP_CLIENT_SECRET: z.string().min(1),
      // owner/repo of the GitHub App installation used for app-authenticated
      // reads (e.g. Desktop release lookup via getAuthenticatedOctokit()).
      GITHUB_APP_DISPATCH_REPO: z.string().regex(OWNER_REPO_REGEX),
      WEBAPP_ENV: z.enum(["local", "stage", "prod"]).default("stage"),
    },
    runtimeEnv: {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
      GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET,
      GITHUB_APP_DISPATCH_REPO: process.env.GITHUB_APP_DISPATCH_REPO,
      WEBAPP_ENV: process.env.WEBAPP_ENV,
    },
  });

/**
 * App-safe GitHub keys - extended via createEnv in apps/app.
 * Optional because GitHub is an optional integration.
 *
 * - GITHUB_APP_CLIENT_ID: Needed by both app (OAuth initiation) and API (token exchange)
 *   Follows the Google/Linear pattern of server-side optional keys.
 */
export const clientKeys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      // GitHub App client ID for OAuth authorize URL - optional since GitHub integration is optional
      GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
    },
    client: {
      // GitHub App slug for install URL - optional since GitHub integration is optional
      NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().min(1).optional(),
    },
    runtimeEnv: {
      GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
      NEXT_PUBLIC_GITHUB_APP_SLUG: process.env.NEXT_PUBLIC_GITHUB_APP_SLUG,
    },
  });

/**
 * Narrow validator for GitHub webhook signature verification, which only needs
 * the webhook secret. Kept separate from `keys()` so verifying a (kept) GitHub
 * webhook does not transitively require unrelated GitHub App config — OAuth
 * client credentials or the App installation repo — which would otherwise fail
 * validation in partial-config environments. The webhook route still gates on
 * `isGitHubConfigured()` before verification is attempted.
 */
export const webhookSecretKeys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
    },
    runtimeEnv: {
      GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
    },
  });
