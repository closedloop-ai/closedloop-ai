import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RelayDispatchDiagnosticReason,
  relayDispatchNotDelivered,
} from "@repo/api/src/types/relay-dispatch";
import { log } from "@repo/observability/log";
import { parseDispatchBody, validateSecret } from "./dispatch.js";
import { jsonResponse } from "./http-io.js";
import { tryProxyDispatch } from "./proxy-dispatch.js";
import { isCurrentRegistryOwner } from "./registry-ownership.js";
import {
  RegistryLookupOutcome,
  type TargetLookupResult,
  type TargetMetadata,
  type TargetRegistry,
} from "./target-registry.js";
import { workersByTargetId } from "./worker-registry.js";

type DispatchHandlerDependencies = {
  targetRegistry: TargetRegistry;
  relayInstanceId: string;
};

export async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: DispatchHandlerDependencies
): Promise<void> {
  if (!validateSecret(req.headers["x-internal-secret"])) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  const payload = await parseDispatchBody(req, res);
  if (!payload) {
    return;
  }

  const { targetId, operation } = payload;
  const worker = workersByTargetId.get(targetId);
  if (worker) {
    const registered = targetMetadataFromLookup(
      await dependencies.targetRegistry.lookup(targetId)
    );
    if (
      registered?.instanceId === dependencies.relayInstanceId &&
      registered.ownerToken !== worker.ownerToken
    ) {
      jsonResponse(
        res,
        200,
        relayDispatchNotDelivered(
          RelayDispatchDiagnosticReason.SameInstanceOwnerTokenMismatch
        )
      );
      return;
    }
    if (
      isCurrentRegistryOwner(registered, worker, dependencies.relayInstanceId)
    ) {
      log.info("Dispatch: emitting desktop.command to worker", {
        targetId,
        socketId: worker.socket.id,
        socketConnected: worker.socket.connected,
      });
      worker.socket.emit("desktop.command", operation);
      jsonResponse(res, 200, { delivered: true });
      return;
    }
  }

  const proxyResult = await tryProxyDispatch(
    dependencies.targetRegistry,
    dependencies.relayInstanceId,
    targetId,
    operation
  );
  jsonResponse(res, 200, proxyResult);
}

function targetMetadataFromLookup(
  lookup: TargetLookupResult
): TargetMetadata | null {
  if (lookup.outcome === RegistryLookupOutcome.Found) {
    return lookup.metadata;
  }
  return null;
}
