import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    server: {
      FLAGS_SECRET: z.string().optional(),
    },
    client: {
      NEXT_PUBLIC_USE_LOOPS_COMPUTE: z
        .string()
        .transform((v) => v === "true")
        .optional(),
    },
    runtimeEnv: {
      FLAGS_SECRET: process.env.FLAGS_SECRET,
      NEXT_PUBLIC_USE_LOOPS_COMPUTE: process.env.NEXT_PUBLIC_USE_LOOPS_COMPUTE,
    },
  });
