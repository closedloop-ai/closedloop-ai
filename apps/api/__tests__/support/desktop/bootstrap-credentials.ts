import { generateKeyPairSync, sign } from "node:crypto";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
} from "@repo/api/src/types/api-key";

export const bootstrapKeys = generateKeyPairSync("ed25519");
export const bootstrapMintInput = {
  clerkUserId: "user_clerk",
  gatewayId: "gateway-1",
  gatewayPublicKeyPem: bootstrapKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  redirectUri: "http://127.0.0.1:49152/cb",
};
export const bootstrapCodeVerifier =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

export function bootstrapExchangeRequest(
  code: string,
  overrides: Record<string, unknown> = {}
) {
  const path = "/desktop/bootstrap-authorize/token";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    null,
    Buffer.from(
      ["POST", path, timestamp, bootstrapMintInput.gatewayId].join("\n")
    ),
    bootstrapKeys.privateKey
  ).toString("base64url");
  return new Request(`http://localhost:3002${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DESKTOP_POP_GATEWAY_ID_HEADER]: bootstrapMintInput.gatewayId,
      [DESKTOP_POP_TIMESTAMP_HEADER]: timestamp,
      [DESKTOP_POP_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify({
      code,
      codeVerifier: bootstrapCodeVerifier,
      gatewayId: bootstrapMintInput.gatewayId,
      redirectUri: bootstrapMintInput.redirectUri,
      ...overrides,
    }),
  });
}
