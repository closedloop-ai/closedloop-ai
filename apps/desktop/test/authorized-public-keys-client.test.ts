import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchOrganizationCommandKeys } from "../src/main/authorized-public-keys-client.js";
import { BROWSER_KEY_TARGET_ACCESS } from "../src/shared/contracts.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";

test("fetchOrganizationCommandKeys sends target query params and preserves raw targetContext", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | null = null;
  try {
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            makeKey({
              targetContext: {
                computeTargetId: TARGET_ID,
                gatewayId: GATEWAY_ID,
                access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
              },
            }),
            makeKey({
              fingerprint: "cl:malformedtarget12",
              targetContext: {
                computeTargetId: TARGET_ID,
                gatewayId: null,
                access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
              },
            }),
            makeKey({
              fingerprint: "cl:sharedtargetkey123",
              targetContext: {
                computeTargetId: TARGET_ID,
                gatewayId: GATEWAY_ID,
                access: "shared_target",
              },
            }),
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const keys = await fetchOrganizationCommandKeys({
      apiOrigin: "https://api.example.test",
      apiKey: "sk_live_test",
      apiKeyProvenance: "DESKTOP_MANAGED",
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
    });

    assert.equal(
      requestedUrl,
      `https://api.example.test/public-keys?computeTargetId=${TARGET_ID}&gatewayId=${GATEWAY_ID}`
    );
    assert.equal(keys.length, 3);
    assert.deepEqual(keys[1].targetContext, {
      computeTargetId: TARGET_ID,
      gatewayId: null,
      access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
    });
    assert.deepEqual(keys[2].targetContext, {
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
      access: "shared_target",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchOrganizationCommandKeys still rejects invalid top-level key shapes", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              userId: "user-1",
              organizationId: "org-1",
              publicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
              fingerprint: "cl:abcdefghijklmnopqrstuv",
              createdAt: "2026-05-09T00:00:00.000Z",
            },
          ],
        }),
        { status: 200 }
      );

    await assert.rejects(
      fetchOrganizationCommandKeys({
        apiOrigin: "https://api.example.test",
        apiKey: "sk_live_test",
        apiKeyProvenance: "USER_CREATED",
      }),
      /Invalid public keys response/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeKey(overrides?: {
  fingerprint?: string;
  targetContext?: unknown;
}) {
  return {
    id: overrides?.fingerprint ?? "cl:abcdefghijklmnopqrstuv",
    userId: "user-1",
    organizationId: "org-1",
    publicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    fingerprint: overrides?.fingerprint ?? "cl:abcdefghijklmnopqrstuv",
    createdAt: "2026-05-09T00:00:00.000Z",
    ownerName: "Org User",
    ...(overrides?.targetContext === undefined
      ? {}
      : { targetContext: overrides.targetContext }),
  };
}
