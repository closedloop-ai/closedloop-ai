import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    server: {
      // Vercel OIDC + RDS IAM authentication
      AWS_ROLE_ARN: z.string(),
      AWS_REGION: z.string(),
      PGHOST: z.string(),
      PGPORT: z.string().default("5432"),
      PGUSER: z.string(),
      PGDATABASE: z.string(),
      // Optional: direct connection string for Prisma migrations (break-glass)
      DATABASE_URL: z.url().optional(),
    },
    runtimeEnv: {
      AWS_ROLE_ARN: process.env.AWS_ROLE_ARN,
      AWS_REGION: process.env.AWS_REGION,
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGUSER: process.env.PGUSER,
      PGDATABASE: process.env.PGDATABASE,
      DATABASE_URL: process.env.DATABASE_URL,
    },
  });
