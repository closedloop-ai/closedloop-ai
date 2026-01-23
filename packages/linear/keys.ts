import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    server: {
      LINEAR_CLIENT_ID: z.string().min(1),
      LINEAR_CLIENT_SECRET: z.string().min(1),
      LINEAR_REDIRECT_URI: z.string().url(),
    },
    runtimeEnv: {
      LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
      LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
      LINEAR_REDIRECT_URI: process.env.LINEAR_REDIRECT_URI,
    },
  });
