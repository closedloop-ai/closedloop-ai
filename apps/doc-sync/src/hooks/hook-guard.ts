import { ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Extension, HookName } from "@hocuspocus/server";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { errorCode } from "../storage/error-code";
import { DocSyncCount, emitDocSyncMetric } from "../telemetry/metrics";

export const HookFailurePolicy = {
  /**
   * Logged and resolved: Hocuspocus 4.7.0 leaves this hook's rejection
   * unhandled, or answers it with worse than the hook's own failure: refusing
   * a connected client, vetoing an unload, keeping a stored document loaded.
   */
  Contain: "contain",
  /** Logged and rethrown: Hocuspocus contains it to one connection or document. */
  Propagate: "propagate",
  /** Logged, the HTTP request or upgrade answered 500, then rejected with no value. */
  Answer: "answer",
} as const;
export type HookFailurePolicy =
  (typeof HookFailurePolicy)[keyof typeof HookFailurePolicy];

/**
 * What a hook's unexpected rejection does, per Hocuspocus 4.7.0's dispatch of
 * that hook (PLN-2201 Implementation Notes). Exhaustive, so a hook a
 * Hocuspocus upgrade adds fails `tsc` until it is placed.
 */
export const HOOK_FAILURE_POLICY: Record<HookName, HookFailurePolicy> = {
  onListen: HookFailurePolicy.Propagate,
  onConnect: HookFailurePolicy.Propagate,
  onAuthenticate: HookFailurePolicy.Propagate,
  onTokenSync: HookFailurePolicy.Propagate,
  onCreateDocument: HookFailurePolicy.Propagate,
  onLoadDocument: HookFailurePolicy.Propagate,
  // Not PLN-2201's Contain: this hook installs the seed's version guard
  // (`revertClientMetaWrites`, PLN-2190), so a failure must refuse the client
  // rather than serve the document unguarded. A failed load is never
  // registered, so the next connection loads it afresh.
  afterLoadDocument: HookFailurePolicy.Propagate,
  beforeHandleMessage: HookFailurePolicy.Propagate,
  beforeHandleAwareness: HookFailurePolicy.Propagate,
  beforeSync: HookFailurePolicy.Propagate,
  onStoreDocument: HookFailurePolicy.Propagate,
  onRequest: HookFailurePolicy.Answer,
  onUpgrade: HookFailurePolicy.Answer,
  onConfigure: HookFailurePolicy.Contain,
  connected: HookFailurePolicy.Contain,
  afterHandleMessage: HookFailurePolicy.Contain,
  beforeBroadcastStateless: HookFailurePolicy.Contain,
  onStateless: HookFailurePolicy.Contain,
  onChange: HookFailurePolicy.Contain,
  afterStoreDocument: HookFailurePolicy.Contain,
  onAwarenessUpdate: HookFailurePolicy.Contain,
  onDisconnect: HookFailurePolicy.Contain,
  beforeUnloadDocument: HookFailurePolicy.Contain,
  afterUnloadDocument: HookFailurePolicy.Contain,
  onDestroy: HookFailurePolicy.Contain,
};

export const DOC_SYNC_HOOK_FAILED_EVENT = "doc_sync.hook_failed";

export const INTERNAL_ERROR_UPGRADE_RESPONSE =
  "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/**
 * A copy of `extension` whose every hook handles its own failure per
 * {@link HOOK_FAILURE_POLICY}, so no hook rejection reaches a Hocuspocus code
 * path that leaves it unhandled (upstream #754). Hooks defined on the
 * prototype (the `Database` extension's) are guarded too, and keep `this`.
 *
 * A rejection with no value from a Propagate or Answer hook (a refusal, or
 * `onRequest`/`onUpgrade` saying "answered") and a Propagate refusal carrying
 * a string `reason` (Hocuspocus's convention, as `DocSyncAuthError` does) pass
 * through unlogged. Anything else, a Contain hook's empty rejection included,
 * is logged with ids and codes only, never the error's message, and counted.
 */
export function guardExtension(
  extension: Extension,
  extensionName: string
): Extension {
  const guarded: Extension = { priority: extension.priority };
  for (const name of Object.keys(HOOK_FAILURE_POLICY).filter(isHookName)) {
    const hook = extension[name];
    if (typeof hook !== "function") {
      continue;
    }
    const policy = HOOK_FAILURE_POLICY[name];
    guarded[name] = async (payload: unknown): Promise<unknown> => {
      try {
        return await Reflect.apply(hook, extension, [payload]);
      } catch (error) {
        return handleHookFailure(error, {
          hook: name,
          policy,
          extensionName,
          payload,
        });
      }
    };
  }
  return guarded;
}

function isHookName(name: string): name is HookName {
  return Object.hasOwn(HOOK_FAILURE_POLICY, name);
}

type HookFailure = {
  hook: HookName;
  policy: HookFailurePolicy;
  extensionName: string;
  payload: unknown;
};

function handleHookFailure(
  error: unknown,
  { hook, policy, extensionName, payload }: HookFailure
): Promise<undefined> {
  if (
    (error === undefined || error === null) &&
    policy !== HookFailurePolicy.Contain
  ) {
    return Promise.reject(error);
  }
  if (
    policy === HookFailurePolicy.Propagate &&
    refusalSchema.safeParse(error).success
  ) {
    return Promise.reject(error);
  }
  const documentName = documentNameSchema.safeParse(payload).data?.documentName;
  log.error("Doc sync hook failed", {
    event: DOC_SYNC_HOOK_FAILED_EVENT,
    hook,
    extension: extensionName,
    ...(documentName === undefined ? {} : { documentName }),
    code: errorCode(error),
    policy,
  });
  emitDocSyncMetric({ metric: DocSyncCount.HookErrors, count: 1, hook });
  if (policy === HookFailurePolicy.Contain) {
    return Promise.resolve(undefined);
  }
  if (policy === HookFailurePolicy.Answer) {
    answerInternalError(payload);
    return Promise.reject();
  }
  return Promise.reject(error);
}

const refusalSchema = z.object({ reason: z.string() });
const documentNameSchema = z.object({ documentName: z.string() });
const requestPayloadSchema = z.object({
  response: z.instanceof(ServerResponse),
});
const upgradePayloadSchema = z.object({ socket: z.instanceof(Duplex) });

function answerInternalError(payload: unknown): void {
  const request = requestPayloadSchema.safeParse(payload);
  if (request.success) {
    const { response } = request.data;
    if (response.writableEnded) {
      return;
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(HTTP_INTERNAL_SERVER_ERROR, { "content-length": "0" });
    response.end();
    return;
  }
  const upgrade = upgradePayloadSchema.safeParse(payload);
  if (upgrade.success) {
    upgrade.data.socket.end(INTERNAL_ERROR_UPGRADE_RESPONSE);
  }
}

const HTTP_INTERNAL_SERVER_ERROR = 500;
