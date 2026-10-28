import { createHash } from "node:crypto";
import {
  assumedRoleArnPrefix,
  DOC_SYNC_CALLBACK_AUDIENCE,
  DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS,
  DocSyncCallbackHeader,
  STS_GET_CALLER_IDENTITY_QUERY,
} from "@repo/realtime-contract/doc-sync-internal";
import { z } from "zod";

export const DocSyncCallerRefusal = {
  WrongAudience: "wrong_audience",
  BodyHashMismatch: "body_hash_mismatch",
  /** The STS URL is missing, not a regional STS endpoint, or not a GetCallerIdentity presign binding both headers. */
  InvalidStsRequest: "invalid_sts_request",
  StsUnavailable: "sts_unavailable",
  StsRefused: "sts_refused",
  WrongRole: "wrong_role",
} as const;
export type DocSyncCallerRefusal =
  (typeof DocSyncCallerRefusal)[keyof typeof DocSyncCallerRefusal];

export type DocSyncCallerVerdict =
  | { ok: true }
  | { ok: false; reason: DocSyncCallerRefusal };

export const STS_REPLAY_TIMEOUT_MS = 3000;

/**
 * PLN-2200 T-7.7 (Q-001 default A). doc-sync sends a presigned STS
 * `GetCallerIdentity` URL whose signature binds the audience and the body's
 * SHA-256 as headers. This replays it with the audience and the hash of the
 * body actually received, so STS answers only when the signature covers this
 * body and has not expired, and names the signer: accepted only as a session
 * of `roleArn`. The URL must name a regional STS host before anything is
 * fetched.
 */
export async function verifyDocSyncCaller(
  request: Request,
  rawBody: Uint8Array,
  {
    roleArn,
    fetch = globalThis.fetch,
  }: { roleArn: string; fetch?: typeof globalThis.fetch }
): Promise<DocSyncCallerVerdict> {
  const { headers } = request;
  if (
    headers.get(DocSyncCallbackHeader.Audience) !== DOC_SYNC_CALLBACK_AUDIENCE
  ) {
    return refuse(DocSyncCallerRefusal.WrongAudience);
  }
  const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
  if (headers.get(DocSyncCallbackHeader.BodySha256) !== bodySha256) {
    return refuse(DocSyncCallerRefusal.BodyHashMismatch);
  }
  const stsUrl = presignedStsUrl(headers.get(DocSyncCallbackHeader.StsUrl));
  if (stsUrl === undefined) {
    return refuse(DocSyncCallerRefusal.InvalidStsRequest);
  }
  const arn = await callerArn(stsUrl, bodySha256, fetch);
  if (typeof arn !== "string") {
    return refuse(arn.reason);
  }
  const prefix = assumedRoleArnPrefix(roleArn);
  return prefix !== undefined &&
    arn.startsWith(prefix) &&
    arn.length > prefix.length
    ? { ok: true }
    : refuse(DocSyncCallerRefusal.WrongRole);
}

async function callerArn(
  stsUrl: URL,
  bodySha256: string,
  fetch: typeof globalThis.fetch
): Promise<string | { reason: DocSyncCallerRefusal }> {
  let response: Response;
  try {
    response = await fetch(stsUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        [DocSyncCallbackHeader.Audience]: DOC_SYNC_CALLBACK_AUDIENCE,
        [DocSyncCallbackHeader.BodySha256]: bodySha256,
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(STS_REPLAY_TIMEOUT_MS),
    });
  } catch {
    return { reason: DocSyncCallerRefusal.StsUnavailable };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { reason: DocSyncCallerRefusal.StsRefused };
  }
  const identity = stsCallerIdentitySchema.safeParse(
    await response.json().catch(() => undefined)
  );
  return identity.success
    ? identity.data.GetCallerIdentityResponse.GetCallerIdentityResult.Arn
    : { reason: DocSyncCallerRefusal.StsRefused };
}

function presignedStsUrl(raw: string | null): URL | undefined {
  if (raw === null || !URL.canParse(raw)) {
    return;
  }
  const url = new URL(raw);
  const query = url.searchParams;
  const expires = Number(singleParam(query, EXPIRES_PARAM));
  const signedHeaders = singleParam(query, SIGNED_HEADERS_PARAM)?.split(";");
  const valid =
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    STS_HOST.test(url.hostname) &&
    url.pathname === "/" &&
    Object.entries(STS_GET_CALLER_IDENTITY_QUERY).every(
      ([key, value]) => singleParam(query, key) === value
    ) &&
    Number.isInteger(expires) &&
    expires > 0 &&
    expires <= DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS &&
    signedHeaders?.includes(DocSyncCallbackHeader.Audience) &&
    signedHeaders.includes(DocSyncCallbackHeader.BodySha256);
  return valid ? url : undefined;
}

function singleParam(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}

function refuse(reason: DocSyncCallerRefusal): DocSyncCallerVerdict {
  return { ok: false, reason };
}

/** A regional STS endpoint; one label is not enough, since `sts.s3.amazonaws.com` is an S3 bucket (PR #9147 review). */
const STS_HOST = /^sts\.[a-z]{2}(-[a-z]+)+-\d+\.amazonaws\.com$/;
const EXPIRES_PARAM = "X-Amz-Expires";
const SIGNED_HEADERS_PARAM = "X-Amz-SignedHeaders";

/** STS's JSON answer when asked with `Accept: application/json`. */
const stsCallerIdentitySchema = z.object({
  GetCallerIdentityResponse: z.object({
    GetCallerIdentityResult: z.object({ Arn: z.string() }),
  }),
});
