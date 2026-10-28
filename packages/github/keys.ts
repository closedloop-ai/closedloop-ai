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
      // PLN-1742 M5 retired the in-house OAuth client, so the App's OAuth
      // client id/secret are no longer read anywhere — the env vars may
      // remain set in deployments, but nothing validates or consumes them.
      GITHUB_APP_ID: z.string().min(1),
      GITHUB_APP_PRIVATE_KEY: z.string().min(1),
      GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
      // owner/repo of the GitHub App installation used for app-authenticated
      // reads (e.g. Desktop release lookup via getAuthenticatedOctokit()).
      GITHUB_APP_DISPATCH_REPO: z.string().regex(OWNER_REPO_REGEX),
      WEBAPP_ENV: z.enum(["local", "stage", "prod"]).default("stage"),
    },
    runtimeEnv: {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
      GITHUB_APP_DISPATCH_REPO: process.env.GITHUB_APP_DISPATCH_REPO,
      WEBAPP_ENV: process.env.WEBAPP_ENV,
    },
  });

/**
 * App-safe GitHub keys - extended via createEnv in apps/app.
 * Optional because GitHub is an optional integration.
 */
export const clientKeys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    client: {
      // GitHub App slug for install URL - optional since GitHub integration is optional
      NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().min(1).optional(),
    },
    runtimeEnv: {
      NEXT_PUBLIC_GITHUB_APP_SLUG: process.env.NEXT_PUBLIC_GITHUB_APP_SLUG,
    },
  });

/**
 * Narrow validator for GitHub webhook signature verification, which only needs
 * the webhook secret. Kept separate from `keys()` so verifying a (kept) GitHub
 * webhook does not transitively require unrelated GitHub App config — the App
 * installation repo — which would otherwise fail validation in partial-config
 * environments. The webhook route still gates on `isGitHubConfigured()` before
 * verification is attempted.
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
