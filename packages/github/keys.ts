import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// Top-level regex for performance
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const keys = () =>
  createEnv({
    server: {
      GITHUB_APP_ID: z.string().min(1),
      GITHUB_APP_PRIVATE_KEY: z.string().min(1),
      GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
      GITHUB_APP_DISPATCH_REPO: z.string().regex(OWNER_REPO_REGEX), // owner/repo format
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
