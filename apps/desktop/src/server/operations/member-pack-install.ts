import { MEMBER_PACK_INSTALL_PATH } from "@repo/api/src/types/member-pack-install";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";

/**
 * Node-side handler for a member self-service pack install pushed from the web
 * app (FEA-4082): cloud → relay → this local gateway. The cloud has already
 * authorized that the requesting member owns this node; the handler's only job
 * is to start the vetted `installPack` streamRun (the SAME trust model as the
 * renderer catalog-install and the auto-distribution installer — install
 * commands come only from the local pack_catalog).
 *
 * Version-skew: a desktop build that predates this route simply never registers
 * it, so its gateway returns HTTP 501 for the path and the cloud maps that to a
 * `failed` dispatch state — no peer crashes.
 */

export type MemberPackInstaller = (
  packId: string,
  harness: string
) => Promise<{
  started: boolean;
  runId?: number;
  error?: { code: string; message: string };
}>;

function extractPackInstallInput(
  body: Record<string, unknown> | null
): { packId: string; harness: string } | null {
  if (!body) {
    return null;
  }
  const { packId, harness } = body;
  if (typeof packId !== "string" || !packId.trim()) {
    return null;
  }
  if (typeof harness !== "string" || !harness.trim()) {
    return null;
  }
  return { packId: packId.trim(), harness: harness.trim() };
}

export function registerMemberPackInstallRoutes(
  dispatcher: OperationDispatcher,
  installPack: MemberPackInstaller
): void {
  dispatcher.register("POST", MEMBER_PACK_INSTALL_PATH, async (context) => {
    const input = extractPackInstallInput(parseBody(context));
    if (!input) {
      json(context, 400, {
        error: "packId and harness are required",
        code: "invalid_pack_install_request",
      });
      return;
    }

    try {
      const result = await installPack(input.packId, input.harness);
      if (result.started) {
        json(context, 202, {
          accepted: true,
          packId: input.packId,
          harness: input.harness,
          runId: result.runId,
        });
        return;
      }
      json(context, 422, {
        error: result.error?.message ?? "pack install could not be started",
        code: result.error?.code ?? "pack_install_not_started",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gatewayLog.error(
        "member-pack-install",
        `install dispatch failed: ${message}`
      );
      json(context, 500, {
        error: "pack install failed",
        code: "pack_install_failed",
      });
    }
  });
}
