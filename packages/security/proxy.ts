import { defaults, type Options, withVercelToolbar } from "@nosecone/next";

// biome-ignore lint/performance/noBarrelFile: re-exporting security middleware
export { createMiddleware as securityMiddleware } from "@nosecone/next";

// Nosecone security headers configuration
// https://docs.arcjet.com/nosecone/quick-start
export const noseconeOptions: Options = {
  ...defaults,
  // Our content security policy is handled by Clerk in the app and web proxies.
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
