"use client";

import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  DocSyncFirstOpenSeed,
  type DocSyncTokenResponse,
  docSyncTokenResponseSchema,
  issuedRealtimeTokenSchema,
} from "@repo/realtime-contract/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Doc, XmlElement } from "yjs";
import { z } from "zod";
import { DocSyncConfigContext } from "./doc-sync-config";

export type DocSyncRoomHandle = { provider: HocuspocusProvider; ydoc: Doc };

/**
 * `room` is `null` while the first token is minted: "connecting" stays
 * distinct from "not on doc-sync", which is the context being absent.
 * `failed` means a mint was refused (4xx) or answered with something that is
 * not a token; retrying changes neither, so the room stops trying. It also
 * means the first sync found the document empty after the API reported its
 * first-open seed unconfirmed: the latest version may be missing, and an edit
 * would store the document so the seed could never land (ISS-12508, PLN-2229
 * OQ-3, Kerensa Whitlock 2026-10-23: show an error).
 */
export type DocSyncRoomState = {
  room: DocSyncRoomHandle | null;
  failed: boolean;
};

const DocSyncRoomContext = createContext<DocSyncRoomState | undefined>(
  undefined
);

type DocSyncRoomProps = {
  roomId: string;
  readOnly?: boolean;
  children: ReactNode;
};

/**
 * Binds one document room on the doc-sync service (PLN-2189 T-2.2). The first
 * token is minted before the provider exists, because its response names the
 * service URL; every later authentication mints again, so a reconnect never
 * presents an expired token. A `forbidden` refusal is a revoke binding the
 * fresh token too (its `iat` second is at or before the revoke's, PLN-2201
 * GAP-004), so the room mints and authenticates again with backoff, until a
 * token issued after the revoke is admitted or the mint itself is refused.
 */
export function DocSyncRoom({
  roomId,
  readOnly = false,
  children,
}: Readonly<DocSyncRoomProps>) {
  const config = useContext(DocSyncConfigContext);
  const configRef = useRef(config);
  useLayoutEffect(() => {
    configRef.current = config;
  }, [config]);

  const [room, setRoom] = useState<DocSyncRoomHandle | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fetchBody = (): Promise<unknown> => {
      const current = configRef.current;
      return current
        ? current.fetchToken(roomId)
        : Promise.reject(new Error("DocSyncConfigContext is not mounted"));
    };
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let reauthAttempt = 0;
    let reauthTimer: ReturnType<typeof setTimeout> | undefined;
    let handle: DocSyncRoomHandle | undefined;
    // A token minted here and not yet presented; the provider's token
    // callback hands it out once before minting on its own.
    let nextToken: string | undefined;

    const onMintFailed = (error: unknown, retry: () => void) => {
      if (disposed) {
        return;
      }
      if (isRefusedMint(error)) {
        setFailed(true);
      } else {
        retry();
      }
    };

    const scheduleRetry = () => {
      if (disposed) {
        return;
      }
      const delay = mintRetryDelay(attempt);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    };

    const cancelReauth = () => {
      clearTimeout(reauthTimer);
      reauthTimer = undefined;
    };

    // The re-mint is classified like the first one: the provider's own
    // `sendToken` swallows a token-callback rejection, so minting here is what
    // keeps a refused mint from passing for an unsent token.
    const reauthenticate = (provider: HocuspocusProvider) => {
      fetchBody().then(
        (body: unknown) => {
          if (disposed) {
            return;
          }
          const parsed = issuedRealtimeTokenSchema.safeParse(body);
          if (!parsed.success) {
            setFailed(true);
            return;
          }
          nextToken = parsed.data.token;
          provider.sendToken().then(() => provider.startSync());
        },
        (error: unknown) => onMintFailed(error, () => scheduleReauth(provider))
      );
    };

    // The refused authentication left the socket open; a reconnect in the
    // meantime authenticates on its own (`open` cancels this).
    const scheduleReauth = (provider: HocuspocusProvider) => {
      cancelReauth();
      const delay = mintRetryDelay(reauthAttempt);
      reauthAttempt += 1;
      reauthTimer = setTimeout(() => {
        reauthTimer = undefined;
        const socket = provider.configuration.websocketProvider;
        if (!disposed && socket.status === WebSocketStatus.Connected) {
          reauthenticate(provider);
        }
      }, delay);
    };

    // `sendToken` turns a token-callback rejection into a non-`forbidden`
    // `authenticationFailed` and stops, so the reconnect a revoke forces would
    // neither retry nor fail the room (PR #9079 review). Classified like
    // `reauthenticate`; the rethrow keeps the provider from authenticating.
    const mintForProvider = async (
      provider: HocuspocusProvider
    ): Promise<string> => {
      let body: unknown;
      try {
        body = await fetchBody();
      } catch (error) {
        onMintFailed(error, () => scheduleReauth(provider));
        throw error;
      }
      const parsed = issuedRealtimeTokenSchema.safeParse(body);
      if (!parsed.success) {
        if (!disposed) {
          setFailed(true);
        }
        throw parsed.error;
      }
      return parsed.data.token;
    };

    const open = (issued: DocSyncTokenResponse, url: string) => {
      nextToken = issued.token;
      const ydoc = new Doc();
      const provider = new HocuspocusProvider({
        url,
        name: roomId,
        document: ydoc,
        token: async () => {
          if (nextToken !== undefined) {
            const token = nextToken;
            nextToken = undefined;
            return token;
          }
          return await mintForProvider(provider);
        },
      });
      // Only the first mint's report counts: the seed runs before the first
      // sync, and a later reconnect finds a document someone may have emptied.
      if (issued.firstOpenSeed === DocSyncFirstOpenSeed.Unconfirmed) {
        // Registered before any `useDocSyncIsSynced` subscriber, so the mark
        // is set before that hook reads its snapshot.
        const checkFirstSync = () => {
          provider.off("synced", checkFirstSync);
          if (!disposed && isEmptyDocument(ydoc)) {
            providersMissingContent.add(provider);
            // Nothing written from here can store the document and shut out
            // the seed the next load retries.
            provider.disconnect();
            setFailed(true);
          }
        };
        provider.on("synced", checkFirstSync);
      }
      provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
        if (reason === RealtimeErrorCode.Forbidden && !disposed) {
          scheduleReauth(provider);
        }
      });
      provider.on("authenticated", () => {
        reauthAttempt = 0;
        cancelReauth();
      });
      provider.on("open", cancelReauth);
      handle = { provider, ydoc };
      setRoom(handle);
    };

    const onMinted = (body: unknown) => {
      if (disposed) {
        return;
      }
      const parsed = docSyncTokenResponseSchema.safeParse(body);
      if (!parsed.success) {
        setFailed(true);
        return;
      }
      if (parsed.data.url) {
        open(parsed.data, parsed.data.url);
      } else {
        scheduleRetry();
      }
    };

    const connect = () => {
      fetchBody().then(onMinted, (error: unknown) =>
        onMintFailed(error, scheduleRetry)
      );
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      cancelReauth();
      setRoom(null);
      setFailed(false);
      handle?.provider.destroy();
      handle?.ydoc.destroy();
    };
  }, [roomId]);

  const self = config?.self ?? null;
  useEffect(() => {
    if (!room) {
      return;
    }
    room.provider.setAwarenessField(DocSyncAwarenessField.ReadOnly, readOnly);
    if (self) {
      room.provider.setAwarenessField(DocSyncAwarenessField.User, {
        id: self.id,
        color: self.color,
      });
    }
  }, [room, readOnly, self]);

  const value = useMemo(() => ({ room, failed }), [room, failed]);
  return (
    <DocSyncRoomContext.Provider value={value}>
      {children}
    </DocSyncRoomContext.Provider>
  );
}

/** `undefined` outside a `DocSyncRoom`; `{ room: null }` while it connects. */
export function useDocSyncRoom(): DocSyncRoomState | undefined {
  return useContext(DocSyncRoomContext);
}

/** False for a room whose first sync found its first-open seed missing. */
export function useDocSyncIsSynced(): boolean {
  const provider = useDocSyncRoom()?.room?.provider;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!provider) {
        return noop;
      }
      provider.on("synced", onChange);
      provider.on("status", onChange);
      return () => {
        provider.off("synced", onChange);
        provider.off("status", onChange);
      };
    },
    [provider]
  );
  return useSyncExternalStore(
    subscribe,
    () => provider?.isSynced === true && !providersMissingContent.has(provider),
    () => false
  );
}

/**
 * The awareness fields this client writes: `user` is `{ id, color }` (the
 * shape `CollaborationCaret` reads), `readOnly` marks a historical-version
 * reader.
 */
export const DocSyncAwarenessField = {
  User: "user",
  ReadOnly: "readOnly",
} as const;

const MINT_RETRY_BASE_MS = 1000;
const MINT_RETRY_MAX_MS = 30_000;

function noop() {
  // Nothing to unsubscribe before the provider exists.
}

/** Whether this subtree renders under a `DocSyncRoom`, connected or not. */
export function useIsOnDocSync(): boolean {
  return useDocSyncRoom() !== undefined;
}

/**
 * The HTTP status the host's API client puts on an answered failure
 * (`ApiError.status` in `@repo/app`, `0` when no response arrived).
 */
const answeredMintFailureSchema = z.object({ status: z.number().int() });

/**
 * A 4xx is the server's answer about this caller and room (no access, room
 * gone, bad request), which another mint cannot change. 5xx, a timeout, or a
 * network failure is transient and backs off.
 */
function isRefusedMint(error: unknown): boolean {
  const answered = answeredMintFailureSchema.safeParse(error);
  return (
    answered.success &&
    answered.data.status >= 400 &&
    answered.data.status < 500
  );
}

function mintRetryDelay(attempt: number): number {
  return Math.min(MINT_RETRY_BASE_MS * 2 ** attempt, MINT_RETRY_MAX_MS);
}

/** Providers whose first sync found the first-open seed missing; never synced to the editor. */
const providersMissingContent = new WeakSet<HocuspocusProvider>();

/** The node the editor fills an empty document with. */
const EMPTY_BLOCK_NODE_NAME = "paragraph";

/** No content, or only empty paragraphs, which an editor binding may write on mount. */
function isEmptyDocument(ydoc: Doc): boolean {
  return ydoc
    .getXmlFragment(DOCUMENT_FRAGMENT_FIELD)
    .toArray()
    .every(
      (node) =>
        node instanceof XmlElement &&
        node.nodeName === EMPTY_BLOCK_NODE_NAME &&
        node.length === 0
    );
}
