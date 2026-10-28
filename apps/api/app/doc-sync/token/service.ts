import { Result, Status } from "@repo/api/src/types/result";
import type { User } from "@repo/api/src/types/user";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import {
  generateDocumentRoomId,
  parseDocumentRoomId,
} from "@repo/realtime-contract/document-room";
import { GrantAccess } from "@repo/realtime-contract/grants";
import {
  DocSyncFirstOpenSeed,
  type IssuedRealtimeToken,
} from "@repo/realtime-contract/protocol";
import {
  issueRealtimeToken,
  type RealtimeTokenIssueOptions,
} from "@repo/realtime-contract/token";
import { documentService } from "../../documents/document-service";
import { organizationsService } from "../../organizations/service";
import { usersService } from "../../users/service";
import {
  FirstOpenSeedOutcome,
  seedLatestVersionOnFirstOpen,
} from "../internal/first-open-seed";
import { DocSyncTokenErrorCode } from "./doc-sync-token-contract";

export type DocSyncTokenFailure =
  | {
      status: typeof Status.BadRequest;
      code: typeof DocSyncTokenErrorCode.InvalidRoom;
    }
  | { status: typeof Status.Forbidden }
  | {
      status: typeof Status.NotFound;
      code: typeof DocSyncTokenErrorCode.DocumentNotFound;
    };

export type IssuedDocSyncToken = {
  issued: IssuedRealtimeToken;
  slug: string;
  /** Omitted when the first-open seed is confirmed. */
  firstOpenSeed?: DocSyncFirstOpenSeed;
};

export const docSyncTokenService = {
  /**
   * Mints a per-document token carrying one `document:{orgId}:{slug}` grant
   * at `write` (PLN-2099 E4). Every org member edits every document today, so
   * the access is always `write` (PLN-2186 GAP-001). Only the canonical room
   * id of the stored slug is accepted: the legacy `document` namespace and an
   * alias slug name the same document a second way, and would fork it into a
   * second Hocuspocus document.
   */
  issueToken,
};

async function issueToken({
  user,
  room,
  signing,
}: {
  user: Pick<User, "id" | "organizationId">;
  room: string;
  signing: RealtimeTokenIssueOptions;
}): Promise<Result<IssuedDocSyncToken, DocSyncTokenFailure>> {
  const parsed = parseRoomOrNull(room);
  if (parsed === null) {
    return Result.err(INVALID_ROOM);
  }
  if (parsed.organizationId !== user.organizationId) {
    return Result.err({ status: Status.Forbidden });
  }
  const { slug } = parsed;
  if (room !== generateDocumentRoomId(user.organizationId, slug)) {
    return Result.err(INVALID_ROOM);
  }
  const stored = await documentService.findCanonicalSlugAndId(
    slug,
    user.organizationId
  );
  if (stored === null) {
    return Result.err({
      status: Status.NotFound,
      code: DocSyncTokenErrorCode.DocumentNotFound,
    });
  }
  if (stored.slug !== slug) {
    return Result.err(INVALID_ROOM);
  }
  const issued = await issueRealtimeToken(
    {
      sub: user.id,
      org: user.organizationId,
      grants: [
        {
          pattern: formatChannelAddress(
            ChannelKind.Document,
            user.organizationId,
            [slug]
          ),
          access: GrantAccess.Write,
        },
      ],
    },
    signing
  );
  // PR #9079 review: access is re-read only after `issueRealtimeToken` has
  // stamped `iat`. A deactivation committed before this read refuses the mint;
  // one committed after it is followed by a revoke whose time is after `iat`,
  // so the revoke binds the token.
  if (!(await hasLiveAccess(user))) {
    return Result.err({ status: Status.Forbidden });
  }
  // ISS-12508, Kerensa Whitlock 2026-10-22 (option A): every mint seeds a
  // never-stored document before its token returns; a failed seed still
  // issues the token (PLN-2229 A-1), and says so (OQ-3, Kerensa Whitlock 2026-10-23).
  const seed = await seedLatestVersionOnFirstOpen({
    organizationId: user.organizationId,
    slug,
    documentId: stored.id,
  });
  if (seed === FirstOpenSeedOutcome.Unconfirmed) {
    return Result.ok({
      issued,
      slug,
      firstOpenSeed: DocSyncFirstOpenSeed.Unconfirmed,
    });
  }
  return Result.ok({ issued, slug });
}

const INVALID_ROOM: DocSyncTokenFailure = {
  status: Status.BadRequest,
  code: DocSyncTokenErrorCode.InvalidRoom,
};

/** `parseDocumentRoomId` throws on a malformed room id. */
function parseRoomOrNull(
  room: string
): { organizationId: string; slug: string } | null {
  try {
    return parseDocumentRoomId(room);
  } catch {
    return null;
  }
}

async function hasLiveAccess(
  user: Pick<User, "id" | "organizationId">
): Promise<boolean> {
  const [row, organizationActive] = await Promise.all([
    usersService.findById(user.id, user.organizationId),
    organizationsService.isActive(user.organizationId),
  ]);
  return row?.active === true && organizationActive;
}
