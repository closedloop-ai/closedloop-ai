import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      LIVEBLOCKS_SECRET: z.string().startsWith("sk_").optional(),
      LIVEBLOCKS_WEBHOOK_SECRET: z.string().optional(),
    },
    runtimeEnv: {
      LIVEBLOCKS_SECRET: process.env.LIVEBLOCKS_SECRET,
      LIVEBLOCKS_WEBHOOK_SECRET: process.env.LIVEBLOCKS_WEBHOOK_SECRET,
    },
  });
