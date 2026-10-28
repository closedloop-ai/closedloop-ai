import { emptyNotFound } from "@repo/http-service/errors";
import type { NodeBindings } from "@repo/http-service/node-listener";
import { Hono } from "hono";
import type { HealthProbe } from "./health-probe";

export const HealthPath = {
  Health: "/health",
} as const;

/**
 * `GET /health`, the load balancer's check (ISS-12512): 200 `{ ok: true }`
 * while `probe` reports the document database answering, else 503
 * `{ ok: false }`. Any other method falls through to the app's empty 404.
 * Hono hands a HEAD to the GET handler, so that handler refuses it itself.
 */
export function healthRoutes(
  probe: HealthProbe
): Hono<{ Bindings: NodeBindings }> {
  const routes = new Hono<{ Bindings: NodeBindings }>();
  routes.get(HealthPath.Health, async (c) => {
    if (c.req.method !== "GET") {
      return emptyNotFound(c);
    }
    const { ok } = await probe.check();
    return c.json({ ok }, ok ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE, {
      "cache-control": "no-store",
    });
  });
  return routes;
}

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
