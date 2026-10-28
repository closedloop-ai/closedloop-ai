import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { formatUrl } from "@aws-sdk/util-format-url";
import {
  DOC_SYNC_CALLBACK_AUDIENCE,
  DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS,
  DocSyncCallbackHeader,
  STS_GET_CALLER_IDENTITY_QUERY,
} from "@repo/realtime-contract/doc-sync-internal";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { CallbackSigner } from "./callback-sender";

type CredentialProvider = ReturnType<typeof fromNodeProviderChain>;

/**
 * PLN-2200 Q-001 default A: SigV4-presigns an STS `GetCallerIdentity` request
 * with the task role, as `apps/realtime/src/redis/iam-auth.ts` presigns its
 * Redis token, binding the audience and the body hash as signed headers with
 * a {@link DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS} expiry. The API replays
 * the URL with those headers; STS answers only for an unaltered, unexpired
 * signature, and names the role that made it. Signing is local: the only AWS
 * call here is resolving the task role's credentials.
 */
export function createStsCallerIdentitySigner({
  region,
  credentials = fromNodeProviderChain(),
  now = () => new Date(),
}: {
  region: string;
  credentials?: CredentialProvider;
  now?: () => Date;
}): CallbackSigner {
  const hostname = `sts.${region}.amazonaws.com`;
  const signer = new SignatureV4({
    service: STS_SIGNING_NAME,
    region,
    credentials,
    sha256: Hash.bind(null, "sha256"),
  });
  return async (bodySha256) => {
    const signedHeaders = {
      [DocSyncCallbackHeader.Audience]: DOC_SYNC_CALLBACK_AUDIENCE,
      [DocSyncCallbackHeader.BodySha256]: bodySha256,
    };
    const presigned = await signer.presign(
      {
        method: "GET",
        protocol: "https:",
        hostname,
        path: "/",
        query: { ...STS_GET_CALLER_IDENTITY_QUERY },
        headers: { host: hostname, ...signedHeaders },
      },
      {
        expiresIn: DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS,
        signingDate: now(),
      }
    );
    return {
      ...signedHeaders,
      [DocSyncCallbackHeader.StsUrl]: formatUrl(presigned),
    };
  };
}

const STS_SIGNING_NAME = "sts";
