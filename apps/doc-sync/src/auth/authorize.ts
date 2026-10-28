import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import {
  generateDocumentRoomId,
  parseDocumentRoomId,
} from "@repo/realtime-contract/document-room";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { GrantAccess, matchGrant } from "@repo/realtime-contract/grants";
import type { Revocations } from "@repo/realtime-contract/revocations";
import {
  RealtimeTokenError,
  type RealtimeTokenPublicKeys,
  verifyRealtimeToken,
} from "@repo/realtime-contract/token";

export type DocSyncPrincipal = {
  userId: string;
  orgId: string;
  slug: string;
  /** True when the token grants the document at `read` only (PLN-2186 AC-005). */
  readOnly: boolean;
  /** The token's `iat`, epoch seconds: what a revoke binds. */
  tokenIssuedAt: number;
};

export type DocSyncAuthErrorCode =
  | typeof RealtimeErrorCode.Unauthorized
  | typeof RealtimeErrorCode.TokenExpired
  | typeof RealtimeErrorCode.Forbidden;

/**
 * A refused connection. `reason` is what Hocuspocus 4.7 sends the client as
 * the authentication-failed reason; it reads `reason`, not `message`.
 */
export class DocSyncAuthError extends Error {
  readonly code: DocSyncAuthErrorCode;
  readonly reason: DocSyncAuthErrorCode;

  constructor(code: DocSyncAuthErrorCode) {
    super(code);
    this.name = "DocSyncAuthError";
    this.code = code;
    this.reason = code;
  }
}

/**
 * Admits a connection to `documentName` only when `token` verifies and grants
 * that document's canonical address `document:{orgId}:{slug}` at `read`
 * (PLN-2099 E4). The document name must be the canonical room id
 * `{orgId}:artifact:{slug}`: the legacy namespace names the same document a
 * second way, and would fork it into a second Hocuspocus document. A token a
 * revoke binds (issued at or before it, PLN-2201 T-4.2) is refused
 * `forbidden`, so a client cannot reconnect with a token minted before the
 * revoke closed it.
 */
export async function authorizeConnection(
  token: string,
  documentName: string,
  publicKeys: RealtimeTokenPublicKeys,
  revocations: Pick<Revocations, "covers">
): Promise<DocSyncPrincipal> {
  const claims = await verifiedClaims(token, publicKeys);
  const document = canonicalDocument(documentName);
  if (document === null) {
    throw new DocSyncAuthError(RealtimeErrorCode.Unauthorized);
  }
  const { address, slug } = document;
  if (!matchGrant(claims.grants, address, GrantAccess.Read, claims.org)) {
    throw new DocSyncAuthError(RealtimeErrorCode.Unauthorized);
  }
  if (revocations.covers(claims, address)) {
    throw new DocSyncAuthError(RealtimeErrorCode.Forbidden);
  }
  return {
    userId: claims.sub,
    orgId: claims.org,
    slug,
    readOnly: !matchGrant(
      claims.grants,
      address,
      GrantAccess.Write,
      claims.org
    ),
    tokenIssuedAt: claims.iat,
  };
}

async function verifiedClaims(
  token: string,
  publicKeys: RealtimeTokenPublicKeys
) {
  try {
    return await verifyRealtimeToken(token, { publicKeys });
  } catch (error) {
    throw new DocSyncAuthError(
      error instanceof RealtimeTokenError
        ? error.code
        : RealtimeErrorCode.Unauthorized
    );
  }
}

/** True only for a canonical room id `{orgId}:artifact:{slug}`, the one name a document has. */
export function isCanonicalDocumentName(documentName: string): boolean {
  return canonicalDocument(documentName) !== null;
}

/** The grant address of a canonical room id; null for any other name. */
function canonicalDocument(
  documentName: string
): { address: string; slug: string } | null {
  try {
    const { organizationId, slug } = parseDocumentRoomId(documentName);
    if (documentName !== generateDocumentRoomId(organizationId, slug)) {
      return null;
    }
    return {
      address: formatChannelAddress(ChannelKind.Document, organizationId, [
        slug,
      ]),
      slug,
    };
  } catch {
    // Neither a room id nor an addressable org and slug.
    return null;
  }
}

/** The `document:{orgId}:{slug}` channel address of a canonical room id; null for any other name. */
export function documentChannelAddress(documentName: string): string | null {
  return canonicalDocument(documentName)?.address ?? null;
}
