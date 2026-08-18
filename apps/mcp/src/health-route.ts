import {
  resolveGitSha,
  resolveServerVersion,
} from "@repo/observability/telemetry/context";
import type { HttpRouteHandler } from "./http-route-types.js";
import { sendJson } from "./oauth-http.js";

export const handleHealth: HttpRouteHandler = (_req, res) => {
  sendJson(res, 200, {
    status: "ok",
    version: resolveServerVersion(),
    gitSha: resolveGitSha(),
    timestamp: new Date().toISOString(),
  });
};
