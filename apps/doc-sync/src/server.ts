import { Database } from "@hocuspocus/extension-database";
import {
  type Extension,
  type onAuthenticatePayload,
  Server,
} from "@hocuspocus/server";
import {
  createInternalOidcVerifier,
  type InternalOidcVerifier,
} from "@repo/http-service/internal-oidc";
import { createRevocations } from "@repo/realtime-contract/revocations";
import {
  authenticateWithToken,
  refuseDisallowedOrigin,
} from "./auth/connection-hooks";
import type { CallbackSigner } from "./callbacks/callback-sender";
import { changeCallbacksFor } from "./callbacks/change-callbacks";
import {
  createAdmissionGuard,
  createConnectionControl,
} from "./commands/connection-control";
import {
  createDocumentCommands,
  type DocSyncCommands,
} from "./commands/document-commands";
import { createNeverStoredTracker } from "./commands/first-open-seed";
import { revertClientMetaWrites } from "./commands/version-seed";
import type { DocSyncEnv } from "./env";
import { guardExtension } from "./hooks/hook-guard";
import { createDocSyncHttpApp } from "./http/app";
import { createHealthProbe } from "./http/health-probe";
import { honoRequestHook } from "./http/request-hook";
import { createShutdown } from "./lifecycle/shutdown";
import {
  type DocumentStorage,
  tombstoneAwareStorage,
} from "./storage/document-storage";
import { instrumentedStorage } from "./storage/instrumented-storage";
import { storeOrRetryLater } from "./storage/retry-failed-store";
import { createTombstones, type Tombstones } from "./storage/tombstones";
import { startGaugeReporter } from "./telemetry/gauges";

/** The values the PLN-2183 spike ran. */
const STORE_DEBOUNCE_MS = 2000;
const STORE_MAX_DEBOUNCE_MS = 10_000;

export type DocSyncServerDeps = {
  /** Resolves to admit a connection; rejects to refuse it. Defaults to token authentication. */
  onAuthenticate?: (payload: onAuthenticatePayload) => Promise<unknown>;
  flushLogs?: () => Promise<void>;
  /** Judges the bearer on `/internal/*`. Defaults to the API's Vercel OIDC token per `env.internalOidc`. */
  verifyInternalOidc?: InternalOidcVerifier;
  /** How long a delete waits for its document to unload. Defaults to `DELETE_UNLOAD_DEADLINE_MS`. */
  deleteUnloadDeadlineMs?: number;
  tombstones?: Tombstones;
  /** Additional extensions, guarded like the built-in ones. */
  extensions?: readonly Extension[];
  /** How often the gauges report. Defaults to `GAUGE_INTERVAL_MS`. */
  gaugeIntervalMs?: number;
  /** The revocation clock, epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Signs change callbacks. Defaults to the STS caller-identity signer for `env.callbacks.region`. */
  signChangeCallback?: CallbackSigner;
};

export function createDocSyncServer(
  env: Pick<
    DocSyncEnv,
    | "port"
    | "shutdownDeadlineMs"
    | "tokenPublicKeys"
    | "allowedOrigins"
    | "internalOidc"
    | "callbacks"
  >,
  storage: DocumentStorage,
  deps: DocSyncServerDeps = {}
): {
  server: Server;
  shutdown: () => Promise<void>;
  commands: DocSyncCommands;
} {
  const tombstones = deps.tombstones ?? createTombstones();
  const revocations = createRevocations(deps.now);
  const admission = createAdmissionGuard({ revocations, now: deps.now });
  // Tombstoned stores are no-ops, so they are never sampled.
  const guardedStorage = tombstoneAwareStorage(
    instrumentedStorage(storage),
    tombstones
  );
  const neverStored = createNeverStoredTracker();
  // Delete waits on `afterUnloadDocument` to know the document is gone from
  // memory (PLN-2200 T-3.9). `connected` closes a connection attached to a
  // tombstoned name, or one the admission guard refuses: a delete or revoke
  // landing after `onAuthenticate` resolves and before the document loads
  // finds nothing to close (PR #8954 review). `beforeHandleMessage` refuses
  // the writes such a client queued during the load, which Hocuspocus applies
  // before `connected` runs (PR #9066 review).
  // `afterLoadDocument` keeps clients out of the seed's version guard.
  const commandsExtension: Extension = {
    afterLoadDocument: ({ document }) => {
      revertClientMetaWrites(document);
      neverStored.watch(document);
      return Promise.resolve();
    },
    connected: ({ documentName, instance, connection }) => {
      if (tombstones.has(documentName)) {
        instance.closeConnections(documentName);
      } else {
        admission.attach(documentName, connection);
      }
      return Promise.resolve();
    },
    beforeHandleMessage: ({ documentName, connection }) =>
      admission.admitMessage(documentName, connection),
    afterUnloadDocument: ({ documentName }) => {
      documentUnloaded(documentName);
      neverStored.forget(documentName);
      return Promise.resolve();
    },
  };
  const connectionHooks: Extension = {
    onRequest: (payload) => requestHook(payload),
    onUpgrade: refuseDisallowedOrigin(env.allowedOrigins),
    onAuthenticate:
      deps.onAuthenticate ??
      authenticateWithToken(env.tokenPublicKeys, {
        revocations,
        isDeleted: tombstones.has,
      }),
  };
  const database = new Database({
    fetch: async ({ documentName }) => {
      const state = await guardedStorage.fetch(documentName);
      if (state === null) {
        neverStored.markLoadedFromNull(documentName);
      }
      return state;
    },
    store: (payload) =>
      storeOrRetryLater(payload, () =>
        guardedStorage.store(payload.documentName, payload.state)
      ),
  });
  const callbacks = changeCallbacksFor(env.callbacks, {
    tombstones,
    sign: deps.signChangeCallback,
  });
  // Every hook goes through `guardExtension` (PLN-2201 T-1.2); none is set on
  // the configuration itself. Hocuspocus runs each hook in this order, so the
  // change callbacks' `onStoreDocument` snapshots before `Database` encodes.
  const server = new Server({
    port: env.port,
    name: "doc-sync",
    quiet: true,
    // Shutdown is ours (src/lifecycle/shutdown.ts), bounded by a deadline.
    stopOnSignals: false,
    debounce: STORE_DEBOUNCE_MS,
    maxDebounce: STORE_MAX_DEBOUNCE_MS,
    extensions: [
      guardExtension(connectionHooks, "doc-sync-connection"),
      ...(callbacks
        ? [guardExtension(callbacks.extension, "doc-sync-change-callbacks")]
        : []),
      guardExtension(database, "doc-sync-database"),
      guardExtension(commandsExtension, "doc-sync-commands"),
      ...(deps.extensions ?? []).map((each) =>
        guardExtension(each, "injected")
      ),
    ],
  });
  const stopGauges = startGaugeReporter(
    {
      openDocuments: () => server.hocuspocus.getDocumentsCount(),
      connections: () => server.hocuspocus.getConnectionsCount(),
    },
    deps.gaugeIntervalMs
  );
  const { commands, documentUnloaded } = createDocumentCommands({
    hocuspocus: server.hocuspocus,
    storage: guardedStorage,
    tombstones,
    neverStored,
    unloadDeadlineMs: deps.deleteUnloadDeadlineMs,
  });
  const requestHook = honoRequestHook(
    createDocSyncHttpApp({
      verifyOidc:
        deps.verifyInternalOidc ??
        createInternalOidcVerifier(env.internalOidc, {
          unavailableEvent: DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
        }),
      commands,
      health: createHealthProbe({ ping: storage.ping }),
      connections: createConnectionControl({
        hocuspocus: server.hocuspocus,
        revocations,
        now: deps.now,
      }),
    })
  );
  const shutdown = createShutdown({
    destroy: () => server.destroy(),
    stopGauges,
    closeStorage: storage.close,
    flushCallbacks: callbacks?.flush,
    deadlineMs: env.shutdownDeadlineMs,
    flushLogs: deps.flushLogs,
  });
  return { server, shutdown, commands };
}

export const HTTP_SERVER_ERROR_EVENT = "doc_sync.http_server_error";
export const DOC_SYNC_INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT =
  "doc_sync.internal_oidc_jwks_unavailable";
