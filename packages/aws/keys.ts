import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    server: {
      AWS_ACCESS_KEY_ID: z.string().startsWith("AKIA").optional(),
      AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
      AWS_REGION: z.string().default("us-east-1"),
      FILE_ATTACHMENTS_BUCKET: z.string().min(1).optional(),
    },
    runtimeEnv: {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_REGION: process.env.AWS_REGION,
      FILE_ATTACHMENTS_BUCKET: process.env.FILE_ATTACHMENTS_BUCKET,
    },
  });
