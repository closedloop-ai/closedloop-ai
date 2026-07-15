import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import { ipcMain, type WebContents } from "electron";
import { z } from "zod";
import { PACK_ANALYTICS_IPC_CHANNEL } from "../../shared/pack-analytics-channel.js";
import { unwrapApiEnvelope } from "../api-response-utils.js";
import { fetchJsonAndParse } from "../fetch-json-and-parse.js";

/**
 * Desktop-team overlay bridge: the renderer asks main for a pack's org-wide
 * analytics; main calls the cloud with the signed-in device token (renderers
 * have no cloud REST access). Mirrors the distributions-client auth pattern.
 */

const REQUEST_TIMEOUT_MS = 10_000;

const packAnalyticsSchema = z.object({
  packId: z.string(),
  invocations: z.number(),
  sessions: z.number(),
  klocPerDollar: z.number().nullable(),
  owners: z.array(z.string()),
  deviceCount: z.number(),
});

export type PackAnalyticsIpcDeps = {
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
  isTrustedSender: (sender: WebContents) => boolean;
};

export function registerPackAnalyticsIpc(deps: PackAnalyticsIpcDeps): void {
  ipcMain.handle(
    PACK_ANALYTICS_IPC_CHANNEL,
    async (event, packId: unknown): Promise<PackAnalyticsResponse | null> => {
      if (!deps.isTrustedSender(event.sender)) {
        throw new Error("untrusted sender");
      }
      if (typeof packId !== "string" || packId.length === 0) {
        return null;
      }

      let token: string | null = null;
      try {
        token = await deps.getAccessToken();
      } catch {
        return null;
      }
      const apiOrigin = deps.getApiOrigin();
      if (!(token && apiOrigin)) {
        return null;
      }

      return fetchJsonAndParse(
        `/agent-components/pack/${encodeURIComponent(packId)}`,
        packAnalyticsSchema,
        {
          apiOrigin,
          token,
          unwrap: unwrapApiEnvelope,
          sentinel: null,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }
      );
    }
  );
}
