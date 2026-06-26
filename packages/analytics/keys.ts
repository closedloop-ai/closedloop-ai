import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// GA4 measurement IDs are `G-` followed by alphanumerics only. Used to gate
// rendering of <GoogleAnalytics> so placeholder values (e.g. "G-placeholder-GAID")
// don't send beacons to a non-existent property. Kept out of the env schema so a
// placeholder env value can't hard-fail the build/deploy — it just disables GA.
export const GA_MEASUREMENT_ID_REGEX = /^G-[A-Z0-9]+$/i;

/** True when the value is a real-shaped GA4 measurement ID (not a placeholder). */
export function isValidGaMeasurementId(value: string | undefined): boolean {
  return !!value && GA_MEASUREMENT_ID_REGEX.test(value);
}

export const keys = () =>
  createEnv({
    emptyStringAsUndefined: true,
    client: {
      NEXT_PUBLIC_POSTHOG_KEY: z.string().startsWith("phc_").optional(),
      NEXT_PUBLIC_POSTHOG_HOST: z.url().optional(),
      // Stays permissive (`G-` prefix) so a placeholder env value can't fail the
      // build; the placeholder is filtered at render time via isValidGaMeasurementId.
      NEXT_PUBLIC_GA_MEASUREMENT_ID: z.string().startsWith("G-").optional(),
      NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED: z
        .enum(["true", "false"])
        .optional(),
    },
    runtimeEnv: {
      NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      NEXT_PUBLIC_GA_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
      NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED:
        process.env.NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED,
    },
  });
