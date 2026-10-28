import {
  DOC_SYNC_CALLBACK_AUDIENCE,
  DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS,
  DocSyncCallbackHeader,
  STS_GET_CALLER_IDENTITY_QUERY,
} from "@repo/realtime-contract/doc-sync-internal";
import { describe, expect, it } from "vitest";
import { createStsCallerIdentitySigner } from "../callbacks/sts-signer";

const BODY_SHA256 = "a".repeat(64);
const SIGNED_AT = new Date("2026-10-22T10:00:00.000Z");

function signer() {
  return createStsCallerIdentitySigner({
    region: "us-east-1",
    credentials: () =>
      Promise.resolve({
        accessKeyId: "ASIAEXAMPLE",
        secretAccessKey: "example-secret",
        sessionToken: "example-session",
      }),
    now: () => SIGNED_AT,
  });
}

async function presignedUrl(bodySha256: string): Promise<URL> {
  const headers = await signer()(bodySha256);
  return new URL(headers[DocSyncCallbackHeader.StsUrl] ?? "");
}

describe("createStsCallerIdentitySigner", () => {
  it("presigns a regional STS GetCallerIdentity request that expires in 60 s", async () => {
    const url = await presignedUrl(BODY_SHA256);

    expect(url.origin).toBe("https://sts.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("Action")).toBe(
      STS_GET_CALLER_IDENTITY_QUERY.Action
    );
    expect(url.searchParams.get("Version")).toBe(
      STS_GET_CALLER_IDENTITY_QUERY.Version
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe(
      String(DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS)
    );
    expect(DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS).toBe(60);
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261022T100000Z");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe(
      "example-session"
    );
  });

  it("signs the audience and body hash headers it returns", async () => {
    const headers = await signer()(BODY_SHA256);
    const url = new URL(headers[DocSyncCallbackHeader.StsUrl] ?? "");

    expect(headers[DocSyncCallbackHeader.Audience]).toBe(
      DOC_SYNC_CALLBACK_AUDIENCE
    );
    expect(headers[DocSyncCallbackHeader.BodySha256]).toBe(BODY_SHA256);
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual([
      "host",
      DocSyncCallbackHeader.Audience,
      DocSyncCallbackHeader.BodySha256,
    ]);
  });

  it("signs a different body hash to a different signature", async () => {
    const first = await presignedUrl(BODY_SHA256);
    const second = await presignedUrl("b".repeat(64));

    expect(second.searchParams.get("X-Amz-Signature")).not.toBe(
      first.searchParams.get("X-Amz-Signature")
    );
  });
});
