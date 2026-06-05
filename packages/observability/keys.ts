import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    server: {
      DD_API_KEY: z.string().min(1).optional(),
      DD_SITE: z.string().min(1).optional(),
      DD_SERVICE: z.string().min(1).optional(),
      DD_ENV: z.string().min(1).optional(),
    },
    client: {},
    runtimeEnv: {
      DD_API_KEY: process.env.DD_API_KEY,
      DD_SITE: process.env.DD_SITE,
      DD_SERVICE: process.env.DD_SERVICE,
      DD_ENV: process.env.DD_ENV,
    },
  });
