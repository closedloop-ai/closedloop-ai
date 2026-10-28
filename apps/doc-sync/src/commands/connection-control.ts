// lc-debt: per-process revocations assume one instance (PLN-2099 E2) and are lost on restart; upgrade path: publish revokes over the Redis bus as realtime does when doc-sync scales out
import {
  type CloseEvent,
  Forbidden,
  ResetConnection,
} from "@hocuspocus/common";
import type { Connection, Hocuspocus } from "@hocuspocus/server";
import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { RevokeTarget } from "@repo/realtime-contract/internal";
import {
  REVOCATION_RETENTION_MS,
  type Revocations,
} from "@repo/realtime-contract/revocations";
import { DocSyncAuthError, documentChannelAddress } from "../auth/authorize";
import {
  type DocSyncConnectionContext,
  docSyncConnectionContextSchema,
} from "../auth/connection-hooks";

export const DOC_SYNC_REVOKE_APPLIED_EVENT = "doc_sync.revoke_applied";
export const DOC_SYNC_DISCONNECT_APPLIED_EVENT = "doc_sync.disconnect_applied";

/** The revoke's close: the code only tells it apart from a forced disconnect in logs and traces. */
export const REVOKE_CLOSE_EVENT: CloseEvent = {
  code: Forbidden.code,
  reason: RealtimeErrorCode.Forbidden,
};

export type DocSyncConnectionControl = {
  /** Closes every connection `target` names and refuses tokens issued at or before now; the count closed. */
  revoke(target: RevokeTarget): number;
  /** Closes every connection to `documentName` and refuses nothing; the count closed. */
  disconnectDocument(documentName: string): number;
};

/**
 * PLN-2201 T-5.2. Each matching connection is closed in-band first, which
 * removes it from its document at once, then its socket is closed, so the
 * provider reconnects and mints a fresh token: refused for a user who lost
 * access, a fresh decision for one who kept it, unless the fresh token's
 * `iat` (whole seconds, from the API's clock) falls at or before the revoke's
 * time on this host's clock, which also refuses it. A revoke is recorded
 * before anything closes, so a connection authenticating after it is refused.
 * One that authenticated before it and is still waiting on its document's
 * load is in no document yet; {@link createAdmissionGuard} refuses its writes
 * and closes it when it attaches.
 */
export function createConnectionControl({
  hocuspocus,
  revocations,
  now = Date.now,
}: {
  hocuspocus: Pick<Hocuspocus, "documents">;
  revocations: Pick<Revocations, "record">;
  now?: () => number;
}): DocSyncConnectionControl {
  return {
    revoke(target) {
      revocations.record({ target, at: now() });
      const matches: Connection[] = [];
      for (const [documentName, document] of hocuspocus.documents) {
        for (const connection of document.getConnections()) {
          if (connectionMatches(target, documentName, connection.context)) {
            matches.push(connection);
          }
        }
      }
      const closedConnections = closeEach(matches, REVOKE_CLOSE_EVENT);
      log.info("Doc sync revoke applied", {
        event: DOC_SYNC_REVOKE_APPLIED_EVENT,
        target,
        closedConnections,
      });
      return closedConnections;
    },
    disconnectDocument(documentName) {
      const closedConnections = closeEach(
        hocuspocus.documents.get(documentName)?.getConnections() ?? [],
        ResetConnection
      );
      log.info("Doc sync disconnect applied", {
        event: DOC_SYNC_DISCONNECT_APPLIED_EVENT,
        documentName,
        closedConnections,
      });
      return closedConnections;
    },
  };
}

/** A context that fails to parse never matches a user or org target. */
function connectionMatches(
  target: RevokeTarget,
  documentName: string,
  context: unknown
): boolean {
  if ("channel" in target) {
    return documentChannelAddress(documentName) === target.channel;
  }
  const parsed = docSyncConnectionContextSchema.safeParse(context);
  if (!parsed.success) {
    return false;
  }
  return "userId" in target
    ? parsed.data.userId === target.userId
    : parsed.data.orgId === target.orgId;
}

export type DocSyncAdmissionGuard = {
  /** The `connected` hook: closes a connection it must refuse, as a revoke does, else marks it attached; true if it closed. */
  attach(documentName: string, connection: Connection): boolean;
  /** The `beforeHandleMessage` hook: rejects, `forbidden`, a message from a connection it must refuse. */
  admitMessage(documentName: string, connection: Connection): Promise<void>;
};

/**
 * Refuses a connection whose token a revoke binds. Until the connection
 * attaches it also refuses one whose token is older than
 * `REVOCATION_RETENTION_MS`: a revoke binding it may have been dropped from
 * the ledger, and a connection outlives its token here. Hocuspocus applies
 * the messages a client sent during its document's load before `connected`
 * runs, so writes are refused message by message, not only at attach. A
 * context that fails to parse is never refused.
 */
export function createAdmissionGuard({
  revocations,
  now = Date.now,
}: {
  revocations: Pick<Revocations, "covers">;
  now?: () => number;
}): DocSyncAdmissionGuard {
  const attached = new WeakSet<Connection>();
  const contexts = new WeakMap<Connection, DocSyncConnectionContext | null>();

  const contextOf = (connection: Connection) => {
    let context = contexts.get(connection);
    if (context === undefined) {
      context =
        docSyncConnectionContextSchema.safeParse(connection.context).data ??
        null;
      contexts.set(connection, context);
    }
    return context;
  };

  const mustRefuse = (documentName: string, connection: Connection) => {
    const context = contextOf(connection);
    const address = documentChannelAddress(documentName);
    if (context === null || address === null) {
      return false;
    }
    if (
      revocations.covers(
        { sub: context.userId, iat: context.tokenIssuedAt },
        address
      )
    ) {
      return true;
    }
    return (
      !attached.has(connection) &&
      now() >= context.tokenIssuedAt * 1000 + REVOCATION_RETENTION_MS
    );
  };

  return {
    attach(documentName, connection) {
      if (mustRefuse(documentName, connection)) {
        closeEach([connection], REVOKE_CLOSE_EVENT);
        return true;
      }
      attached.add(connection);
      return false;
    },
    admitMessage(documentName, connection) {
      return mustRefuse(documentName, connection)
        ? Promise.reject(new DocSyncAuthError(RealtimeErrorCode.Forbidden))
        : Promise.resolve();
    },
  };
}

function closeEach(connections: Connection[], event: CloseEvent): number {
  for (const connection of connections) {
    connection.close(event);
    connection.webSocket.close(event.code, event.reason);
  }
  return connections.length;
}
