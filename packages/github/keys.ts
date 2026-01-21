import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// Top-level regex for performance
const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const keys = () =>
  createEnv({
    server: {
      SYMPHONY_APP_ID: z.string().min(1),
      SYMPHONY_APP_PRIVATE_KEY: z.string().min(1),
      GITHUB_WEBHOOK_SECRET: z.string().min(1),
      SYMPHONY_DISPATCH_REPO: z.string().regex(OWNER_REPO_REGEX), // owner/repo format
      WEBAPP_ENV: z.enum(["local", "stage", "prod"]).default("stage"),
    },
    runtimeEnv: {
      SYMPHONY_APP_ID: process.env.SYMPHONY_APP_ID,
      SYMPHONY_APP_PRIVATE_KEY: process.env.SYMPHONY_APP_PRIVATE_KEY,
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
      SYMPHONY_DISPATCH_REPO: process.env.SYMPHONY_DISPATCH_REPO,
      WEBAPP_ENV: process.env.WEBAPP_ENV,
    },
  });
