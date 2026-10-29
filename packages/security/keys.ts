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
      // Per-environment CSP allowlist extensions for hosts only the deployment
      // knows (the presigned attachment/transcript S3 buckets, ISS-7475).
      // Origins only — never a wildcard bucket domain, which would reopen the
      // arbitrary-bucket exfiltration channel the strict CSP exists to close.
      CSP_EXTRA_IMG_SRC: cspExtraSourceList("CSP_EXTRA_IMG_SRC"),
      CSP_EXTRA_CONNECT_SRC: cspExtraSourceList("CSP_EXTRA_CONNECT_SRC"),
    },
    client: {},
    runtimeEnv: {
      CSP_ENABLED: process.env.CSP_ENABLED,
      CSP_REPORT_URI: process.env.CSP_REPORT_URI,
      CSP_EXTRA_IMG_SRC: process.env.CSP_EXTRA_IMG_SRC,
      CSP_EXTRA_CONNECT_SRC: process.env.CSP_EXTRA_CONNECT_SRC,
    },
  });

function cspExtraSourceList(name: string) {
  return z
    .string()
    .transform((value) => value.split(",").map((entry) => entry.trim()))
    .refine(
      (origins) => origins.every(isHttpsOrigin),
      `${name} must be a comma-separated list of https:// origins with no path`
    )
    .optional();
}

// The URL parser accepts `*` in hostnames (`new URL("https://*.example.com")`
// parses, origin intact), so the origin round-trip alone would let a wildcard
// CSP host-source through. The charset check is what actually rejects it.
const HOSTNAME_CHARSET = /^[a-z0-9.-]+$/;

function isHttpsOrigin(candidate: string): boolean {
  if (!candidate.startsWith("https://")) {
    return false;
  }
  try {
    const url = new URL(candidate);
    // `origin === candidate` pins the entry to exactly scheme + host[:port]:
    // no path, search, hash, trailing slash, or normalization drift.
    return HOSTNAME_CHARSET.test(url.hostname) && url.origin === candidate;
  } catch {
    return false;
  }
}
