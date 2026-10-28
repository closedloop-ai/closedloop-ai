import type { NodeBindings } from "@repo/http-service/node-listener";
import { Hono } from "hono";
import type { Readiness } from "../lifecycle/readiness";

export const HealthPath = {
  Health: "/health",
  Ready: "/ready",
} as const;

/**
 * PLN-2104 step 8. `/health` answers 200 whenever the process can answer at
 * all; `/ready` answers 200 only once readiness has latched. Both answer any
 * method. socket.io takes its own path before the Hono app sees a request;
 * any other path is the app's 404.
 */
export function healthRoutes(
  readiness: Readiness
): Hono<{ Bindings: NodeBindings }> {
  const app = new Hono<{ Bindings: NodeBindings }>();
  app.all(HealthPath.Health, (c) =>
    c.json({ degraded: readiness.isDegraded() }, HTTP_OK, NO_STORE)
  );
  app.all(HealthPath.Ready, (c) => {
    const ready = readiness.isReady();
    return c.json(
      { ready },
      ready ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE,
      NO_STORE
    );
  });
  return app;
}

const NO_STORE = { "cache-control": "no-store" };
const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
