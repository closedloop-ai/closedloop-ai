/**
 * @file catalog-convert-install-ipc.ts
 * @description Registration of the FEA-4079 convert-engine IPC handler
 * (`desktop:db:catalog-convert-install`), extracted out of
 * `agent-dashboard-design-system-runtime.ts` (a shrink-only grandfathered file)
 * so that file trends smaller. The handler validates the untrusted renderer
 * request through the shared `convertInstallRequestSchema`, then drives
 * {@link convertInstall} over the EXISTING `streamRun` catalog install path — the
 * same vetted-command trust model as `catalog-install` — reporting the honest
 * boundary state (converting / partial / unsupported / transient-vs-permanent
 * error) and preserving FEA-4028 source-harness provenance.
 */

import {
  ConvertFailureClass,
  convertInstallRequestSchema,
  makeConvertInstallErrorOutcome,
} from "@repo/api/src/types/convert-install";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { CATALOG_CONVERT_INSTALL_CHANNEL } from "../dashboard/agent-dashboard-ipc-contract.js";
// ISS-5262: the canonical `withDb` contract, imported rather than re-declared.
// This module used to carry a byte-identical copy of the type, which pinned the
// pre-ISS-5262 `Promise<TResult>` return and made the widened wrapper (it can
// now resolve the shutdown sentinel) unassignable here.
import type { WithDb } from "../dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { convertInstall } from "./convert-engine.js";
import { streamRun } from "./install-orchestrator.js";

/** Store-op invoker used to rescan the pack inventory after an install completes. */
type InvokeStoreOp = (name: string, args?: unknown[]) => Promise<unknown>;

type RegisterCatalogConvertInstallHandlerDeps = {
  readonly withDb: WithDb;
  readonly getWindow: () => BrowserWindow | null;
  readonly invokeStoreOp: InvokeStoreOp;
};

/**
 * Register the `desktop:db:catalog-convert-install` handler (FEA-4079). Convert a
 * component to the target harness's format and install it, as ONE gateway
 * operation. A malformed request never reaches the engine and returns a
 * contract-complete permanent error outcome; a valid request drives
 * {@link convertInstall} over `streamRun`.
 */
export function registerCatalogConvertInstallHandler(
  deps: RegisterCatalogConvertInstallHandlerDeps
): void {
  const { withDb, getWindow, invokeStoreOp } = deps;
  ipcMain.handle(
    CATALOG_CONVERT_INSTALL_CHANNEL,
    withDb((agentDatabase, rawRequest: unknown) => {
      const parsed = convertInstallRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        // A malformed request never reaches the engine, so return a contract-
        // complete outcome (with the required identity/capability/droppedFields)
        // rather than a partial `{ state, failureClass, message }` literal the
        // `Promise<ConvertInstallOutcome>` consumers could deref past. Permanent:
        // the SAME bad payload cannot succeed on retry.
        return makeConvertInstallErrorOutcome({
          failureClass: ConvertFailureClass.Permanent,
          message: "Invalid convert-install request.",
        });
      }
      return convertInstall(parsed.data, (packId, targetHarness, cwd) =>
        streamRun(agentDatabase, {
          pack_id: packId,
          harness: targetHarness,
          action: "install",
          cwd,
          getWindow,
          // Mirror the catalog-install handler: rescan the pack inventory once
          // the install subprocess completes so the new state is reflected.
          onComplete: () => {
            invokeStoreOp("packScanner.run").catch(() => {
              // best-effort rescan; a failure here must not surface to the caller
            });
          },
        })
      );
    })
  );
}
