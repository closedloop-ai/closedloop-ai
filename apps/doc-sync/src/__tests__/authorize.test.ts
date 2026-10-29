import { generateKeyPairSync } from "node:crypto";
import { ChannelKind } from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { GRANT_WILDCARD, GrantAccess } from "@repo/realtime-contract/grants";
import { createRevocations } from "@repo/realtime-contract/revocations";
import { REALTIME_TOKEN_TTL_SECONDS } from "@repo/realtime-contract/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeConnection, type DocSyncAuthError } from "../auth/authorize";
import {
  DOCUMENT_NAME,
  documentToken,
  ORG,
  OTHER_ORG,
  PUBLIC_KEYS,
  SLUG,
  signToken,
  USER_ID,
} from "./auth/test-tokens";

const NO_REVOCATIONS = createRevocations();

afterEach(() => {
  vi.useRealTimers();
});

function refusal(code: DocSyncAuthError["code"]) {
  return expect.objectContaining({
    name: "DocSyncAuthError",
    code,
    reason: code,
    message: code,
  });
}

describe("authorizeConnection", () => {
  it("admits a write grant on the document read-write", async () => {
    const token = await documentToken(GrantAccess.Write);

    await expect(
      authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, NO_REVOCATIONS)
    ).resolves.toEqual({
      userId: USER_ID,
      orgId: ORG,
      slug: SLUG,
      readOnly: false,
      tokenIssuedAt: expect.any(Number),
    });
  });

  it("admits a read grant on the document read-only", async () => {
    const token = await documentToken(GrantAccess.Read);

    await expect(
      authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, NO_REVOCATIONS)
    ).resolves.toMatchObject({ readOnly: true });
  });

  it("refuses a token for another document", async () => {
    const token = await documentToken(GrantAccess.Write, { slug: "PLN-2" });

    await expect(
      authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, NO_REVOCATIONS)
    ).rejects.toEqual(refusal(RealtimeErrorCode.Unauthorized));
  });

  it("refuses another org's token, even one whose grant names this org's document", async () => {
    const otherOrgDocument = await documentToken(GrantAccess.Write, {
      org: OTHER_ORG,
    });
    const reachingIn = await signToken({
      sub: USER_ID,
      org: OTHER_ORG,
      grants: [
        {
          pattern: `${ChannelKind.Document}:${ORG}:${SLUG}`,
          access: GrantAccess.Write,
        },
      ],
    });

    for (const token of [otherOrgDocument, reachingIn]) {
      await expect(
        authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, NO_REVOCATIONS)
      ).rejects.toEqual(refusal(RealtimeErrorCode.Unauthorized));
    }
  });

  it("refuses a realtime token, whose grants are comments-only", async () => {
    const token = await signToken({
      sub: USER_ID,
      org: ORG,
      grants: [
        {
          pattern: `${ChannelKind.Comments}:${ORG}:${GRANT_WILDCARD}`,
          access: GrantAccess.Read,
        },
      ],
    });

    await expect(
      authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, NO_REVOCATIONS)
    ).rejects.toEqual(refusal(RealtimeErrorCode.Unauthorized));
  });

  it("refuses an expired token as token_expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 2 * REALTIME_TOKEN_TTL_SECONDS * 1000);
    const token = await documentToken(GrantAccess.Write);
    vi.useRealTimers();

    await expect(
      authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, NO_REVOCATIONS)
    ).rejects.toEqual(refusal(RealtimeErrorCode.TokenExpired));
  });

  it("refuses a token signed by a key it does not trust", async () => {
    const token = await signToken(
      {
        sub: USER_ID,
        org: ORG,
        grants: [
          {
            pattern: `${ChannelKind.Document}:${ORG}:${SLUG}`,
            access: GrantAccess.Write,
          },
        ],
      },
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    );

    await expect(
      authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, NO_REVOCATIONS)
    ).rejects.toEqual(refusal(RealtimeErrorCode.Unauthorized));
  });

  it("refuses a malformed token", async () => {
    await expect(
      authorizeConnection(
        "not-a-token",
        DOCUMENT_NAME,
        PUBLIC_KEYS,
        NO_REVOCATIONS
      )
    ).rejects.toEqual(refusal(RealtimeErrorCode.Unauthorized));
  });

  it.each([
    ["the legacy document namespace", `${ORG}:document:${SLUG}`],
    ["a name that is not a room id", "doc-1"],
    [
      "a room in an org no address can name",
      `${ORG.toUpperCase()}:artifact:${SLUG}`,
    ],
  ])("refuses %s, even with a grant on the document", async (_label, name) => {
    const token = await documentToken(GrantAccess.Write);

    await expect(
      authorizeConnection(token, name, PUBLIC_KEYS, NO_REVOCATIONS)
    ).rejects.toEqual(refusal(RealtimeErrorCode.Unauthorized));
  });
});

describe("authorizeConnection with revocations", () => {
  const OTHER_USER_ID = "user-2";

  function tokenFor(sub: string): Promise<string> {
    return signToken({
      sub,
      org: ORG,
      grants: [
        {
          pattern: `${ChannelKind.Document}:${ORG}:${SLUG}`,
          access: GrantAccess.Write,
        },
      ],
    });
  }

  it("refuses a token a revoke of its user binds as forbidden, and admits another user's", async () => {
    const revoked = await tokenFor(USER_ID);
    const other = await tokenFor(OTHER_USER_ID);
    const revocations = createRevocations();
    revocations.record({ target: { userId: USER_ID }, at: Date.now() });

    await expect(
      authorizeConnection(revoked, DOCUMENT_NAME, PUBLIC_KEYS, revocations)
    ).rejects.toEqual(refusal(RealtimeErrorCode.Forbidden));
    await expect(
      authorizeConnection(other, DOCUMENT_NAME, PUBLIC_KEYS, revocations)
    ).resolves.toMatchObject({ userId: OTHER_USER_ID });
  });

  it("refuses every user's token an org revoke binds as forbidden", async () => {
    const tokens = [await tokenFor(USER_ID), await tokenFor(OTHER_USER_ID)];
    const revocations = createRevocations();
    revocations.record({ target: { orgId: ORG }, at: Date.now() });

    for (const token of tokens) {
      await expect(
        authorizeConnection(token, DOCUMENT_NAME, PUBLIC_KEYS, revocations)
      ).rejects.toEqual(refusal(RealtimeErrorCode.Forbidden));
    }
  });
});
