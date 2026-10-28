/**
 * Shared AWS credentials configuration for Vercel deployments.
 *
 * On Vercel, AWS SDK clients need explicit OIDC credentials to assume
 * the IAM role. Locally / in environments with standard credential chains
 * (env vars, instance profile), this falls back gracefully.
 */

import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type { BoundedRequestHandlerConfig } from "./request-handler";

type CredentialsProvider = S3ClientConfig["credentials"];

let _credentials: CredentialsProvider;

/**
 * Returns the AWS credentials provider for use with SDK clients.
 * Uses Vercel OIDC when AWS_ROLE_ARN is set (deployed on Vercel),
 * otherwise returns undefined to use the default credential chain.
 */
export function getAwsCredentials(): CredentialsProvider {
  const roleArn = process.env.AWS_ROLE_ARN;
  if (!roleArn) {
    return undefined;
  }

  if (!_credentials) {
    _credentials = vercelOidcRoleCredentials(roleArn);
  }

  return _credentials;
}

/**
 * Vercel OIDC → STS AssumeRoleWithWebIdentity for `roleArn`. The web identity
 * is the token's default audience, the one the role trusts. `requestHandler`
 * bounds that STS call: the provider builds its own STS client, which does not
 * inherit the caller's handler.
 */
export function vercelOidcRoleCredentials(
  roleArn: string,
  requestHandler?: BoundedRequestHandlerConfig
): NonNullable<CredentialsProvider> {
  // Dynamic import at init time to avoid bundling @vercel/functions
  // in environments that don't need it (local dev, tests).
  const { awsCredentialsProvider } = require("@vercel/functions/oidc") as {
    awsCredentialsProvider: (opts: {
      roleArn: string;
      clientConfig?: {
        region: string;
        requestHandler?: BoundedRequestHandlerConfig;
      };
    }) => NonNullable<CredentialsProvider>;
  };

  return awsCredentialsProvider({
    roleArn,
    clientConfig: {
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(requestHandler && { requestHandler }),
    },
  });
}
