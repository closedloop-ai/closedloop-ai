/**
 * Shared AWS credentials configuration for Vercel deployments.
 *
 * On Vercel, AWS SDK clients need explicit OIDC credentials to assume
 * the IAM role. Locally / in environments with standard credential chains
 * (env vars, instance profile), this falls back gracefully.
 */

import type { KMSClientConfig } from "@aws-sdk/client-kms";

type CredentialsProvider = KMSClientConfig["credentials"];

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
    // Dynamic import at init time to avoid bundling @vercel/functions
    // in environments that don't need it (local dev, tests).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { awsCredentialsProvider } = require("@vercel/functions/oidc") as {
      awsCredentialsProvider: (opts: {
        roleArn: string;
        clientConfig?: { region: string };
      }) => NonNullable<CredentialsProvider>;
    };

    _credentials = awsCredentialsProvider({
      roleArn,
      clientConfig: { region: process.env.AWS_REGION ?? "us-east-1" },
    });
  }

  return _credentials;
}
