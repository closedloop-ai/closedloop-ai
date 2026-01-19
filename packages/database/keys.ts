import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    server: {
      // Local development: use DATABASE_URL with password auth
      DATABASE_URL: z.url().optional(),

      // Vercel deployments: use OIDC + RDS IAM authentication
      AWS_ROLE_ARN: z.string().optional(),
      AWS_REGION: z.string().optional(),
      PGHOST: z.string().optional(),
      PGPORT: z.string().default("5432"),
      PGUSER: z.string().optional(),
      PGDATABASE: z.string().optional(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      AWS_ROLE_ARN: process.env.AWS_ROLE_ARN,
      AWS_REGION: process.env.AWS_REGION,
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGUSER: process.env.PGUSER,
      PGDATABASE: process.env.PGDATABASE,
    },
  });
