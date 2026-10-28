import { createHash, sign } from "node:crypto";
import {
  KMSClient,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import { vercelOidcRoleCredentials } from "@repo/aws/credentials";
import {
  boundedRequestHandler,
  CONTROL_PLANE_BOUNDS,
} from "@repo/aws/request-handler";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import type {
  RealtimeTokenIssueOptions,
  RealtimeTokenKmsKey,
  RealtimeTokenSigner,
} from "@repo/realtime-contract/token";
import { env, type RealtimeTokenLocalKey, runsOnEcs } from "@/env";

/** Recorded on the token-issue request span (ISS-11210 requirement 16). */
export const KMS_SIGN_DURATION_ATTRIBUTE = "kms.sign.duration_ms";

/**
 * ISS-11966: KMS (RS256) once its key is configured, with no fallback, so a
 * KMS failure fails the request; otherwise the local key (RS256), which
 * env.ts refuses on Vercel production and on ECS. HS256 is retired.
 */
export function realtimeTokenSigning(): RealtimeTokenIssueOptions | undefined {
  const kmsKey = env.REALTIME_TOKEN_KMS_KEY_ID;
  const signerRoleArn = env.REALTIME_TOKEN_SIGNER_ROLE_ARN;
  // env.ts refuses a half-set pair, so either both are set or neither is.
  if (kmsKey !== undefined && signerRoleArn !== undefined) {
    return { signer: kmsTokenSigner(kmsKey, signerRoleArn) };
  }
  const localKey = env.REALTIME_TOKEN_LOCAL_PRIVATE_KEY;
  return localKey === undefined
    ? undefined
    : { signer: localTokenSigner(localKey) };
}

/**
 * ISS-11966 item 1: RS256 through `kms:Sign` on `kmsKey`, in the region its
 * ARN names. Off ECS, as the ISS-11827 signer role through Vercel OIDC. On ECS,
 * which has no Vercel OIDC token, as the task role through the SDK's default
 * credential chain (ISS-12365, the ISS-9108 pattern for packages/database).
 */
function kmsTokenSigner(
  kmsKey: RealtimeTokenKmsKey,
  signerRoleArn: string
): RealtimeTokenSigner {
  return {
    kid: kmsKey.kid,
    sign: async (signingInput) => {
      const startedAt = performance.now();
      try {
        const { Signature } = await signerClient(
          signerRoleArn,
          kmsKey.region
        ).send(
          new SignCommand({
            KeyId: kmsKey.arn,
            Message: createHash("sha256").update(signingInput).digest(),
            MessageType: MessageType.DIGEST,
            SigningAlgorithm: SigningAlgorithmSpec.RSASSA_PKCS1_V1_5_SHA_256,
          })
        );
        if (!Signature) {
          throw new Error("KMS Sign returned no signature");
        }
        return Signature;
      } finally {
        setAppSpanAttributes({
          [KMS_SIGN_DURATION_ATTRIBUTE]: performance.now() - startedAt,
        });
      }
    },
  };
}

let cachedClient:
  | { roleArn: string; region: string; onEcs: boolean; client: KMSClient }
  | undefined;

function signerClient(roleArn: string, region: string): KMSClient {
  const onEcs = runsOnEcs();
  if (
    cachedClient?.roleArn !== roleArn ||
    cachedClient.region !== region ||
    cachedClient.onEcs !== onEcs
  ) {
    // One bound for the Sign call and, off ECS, for the STS call that fetches
    // the signer role's credentials, so neither can hang token issuance.
    const requestHandler = boundedRequestHandler(CONTROL_PLANE_BOUNDS);
    cachedClient = {
      roleArn,
      region,
      onEcs,
      client: new KMSClient({
        region,
        // Undefined is the SDK's default chain: the task role on ECS.
        credentials: onEcs
          ? undefined
          : vercelOidcRoleCredentials(roleArn, requestHandler),
        requestHandler,
      }),
    };
  }
  return cachedClient.client;
}

/** RSASSA-PKCS1-v1_5 SHA-256 under the local key, the scheme KMS signs with. */
function localTokenSigner(key: RealtimeTokenLocalKey): RealtimeTokenSigner {
  return {
    kid: key.kid,
    sign: async (signingInput) => sign("sha256", signingInput, key.privateKey),
  };
}
