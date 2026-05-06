import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    server: {
      CSP_ENABLED: z.enum(["true", "false"]).optional(),
      // This URL is embedded in CSP headers visible to all users — verify it does not contain API keys.
      // Value should match a known DataDog intake domain (e.g., *.browser-intake-datadoghq.com).
      CSP_REPORT_URI: z
        .string()
        .url()
        .refine(
          (url) => url.startsWith("https://"),
          "CSP_REPORT_URI must use HTTPS"
        )
        .optional(),
    },
    client: {},
    runtimeEnv: {
      CSP_ENABLED: process.env.CSP_ENABLED,
      CSP_REPORT_URI: process.env.CSP_REPORT_URI,
    },
  });
