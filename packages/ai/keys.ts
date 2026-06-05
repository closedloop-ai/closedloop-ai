import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    server: {
      ANTHROPIC_API_KEY: z.string().startsWith("sk-").optional(),
      OPENAI_API_KEY: z.string().startsWith("sk-").optional(),
    },
    runtimeEnv: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    },
  });
