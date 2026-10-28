import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import type { GrantAccess } from "@repo/realtime-contract/grants";
import {
  issueRealtimeToken,
  type RealtimeTokenInput,
  type RealtimeTokenPublicKeys,
} from "@repo/realtime-contract/token";

export const ORG = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const OTHER_ORG = "0190a1b2-c3d4-7e5f-8a9b-9c1d2e3f4a5b";
export const SLUG = "PLN-1";
export const USER_ID = "user-1";
export const DOCUMENT_NAME = generateDocumentRoomId(ORG, SLUG);

const KID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const KEY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** The keys the service verifies with: the public half of the key that signs `signToken`'s tokens. */
export const PUBLIC_KEYS: RealtimeTokenPublicKeys = new Map([
  [KID, KEY_PAIR.publicKey],
]);

/** A token signed as the API signs one, RS256 under `KID`. */
export function signToken(
  input: RealtimeTokenInput,
  privateKey: KeyObject = KEY_PAIR.privateKey
): Promise<string> {
  return issueRealtimeToken(input, {
    signer: {
      kid: KID,
      sign: (signingInput) =>
        Promise.resolve(sign("sha256", signingInput, privateKey)),
    },
  }).then((issued) => issued.token);
}

/** A token with one grant on `slug` in `org`, issued to `org`. */
export function documentToken(
  access: GrantAccess,
  { org = ORG, slug = SLUG }: { org?: string; slug?: string } = {}
): Promise<string> {
  return signToken({
    sub: USER_ID,
    org,
    grants: [
      {
        pattern: formatChannelAddress(ChannelKind.Document, org, [slug]),
        access,
      },
    ],
  });
}
