import { defaults, type Options, withVercelToolbar } from "@nosecone/next";

// biome-ignore lint/performance/noBarrelFile: re-exporting security middleware
export { createMiddleware as securityMiddleware } from "@nosecone/next";

// Nosecone security headers configuration
// https://docs.arcjet.com/nosecone/quick-start
export const noseconeOptions: Options = {
  ...defaults,
  // Content Security Policy (CSP) is disabled by default because the values
  // depend on which Next Forge features are enabled. See
  // https://www.next-forge.com/packages/security/headers for guidance on how
  // to configure it.
  contentSecurityPolicy: false,
  // "credentialless" allows cross-origin resources loaded without credentials
  // (e.g., S3 presigned URLs). The default "require-corp" blocks <img> loads
  // from S3 with ERR_BLOCKED_BY_RESPONSE.
  crossOriginEmbedderPolicy: {
    policy: "credentialless",
  },
};

export const noseconeOptionsWithToolbar: Options =
  withVercelToolbar(noseconeOptions);
