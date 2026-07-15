import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      AWS_ACCESS_KEY_ID: z.string().startsWith("AKIA").optional(),
      AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
      AWS_REGION: z.string().default("us-east-1"),
      FILE_ATTACHMENTS_BUCKET: z.string().min(1).optional(),
      // Raw session-transcript archive bucket (FEA-2714 / PLN-1285). Optional in
      // the schema (like FILE_ATTACHMENTS_BUCKET) but required in prod; the
      // transcript helpers throw at runtime when it is unset.
      TRANSCRIPTS_BUCKET: z.string().min(1).optional(),
      // Catalog / plugin-distribution asset bucket (FEA-2923 batch 3).
      // Stores zip bundles and logo images for CatalogItems under
      // org-scoped key prefixes. Optional in schema; throws at runtime when unset
      // (mirrors FILE_ATTACHMENTS_BUCKET / TRANSCRIPTS_BUCKET pattern).
      PLUGIN_STORE_BUCKET: z.string().min(1).optional(),
    },
    runtimeEnv: {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_REGION: process.env.AWS_REGION,
      FILE_ATTACHMENTS_BUCKET: process.env.FILE_ATTACHMENTS_BUCKET,
      TRANSCRIPTS_BUCKET: process.env.TRANSCRIPTS_BUCKET,
      PLUGIN_STORE_BUCKET: process.env.PLUGIN_STORE_BUCKET,
    },
  });
