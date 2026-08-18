import { createServer } from "node:net";

/**
 * Pick a listenable localhost port for a relay test instance.
 *
 * These suites cannot bind port 0 and read the assignment back: the relay reads
 * `RELAY_PORT` from the environment at import time, and the internal-dispatch
 * egress allowlist requires the peer port to equal this instance's own, so the
 * number has to be known BEFORE the server starts. The previous approach —
 * `base + Math.random() * span` with no check — produced a `listen EADDRINUSE`
 * failure whenever the number was already taken, which is exactly what CI hit.
 *
 * Two things make that unlikely enough to rely on:
 *
 * 1. Bands live BELOW the ephemeral floor (32768 on Linux, 49152 on macOS), so
 *    the kernel never hands one of these ports to an outbound socket from a
 *    concurrently-running suite. The old 30k/40k/50k bands sat inside Linux's
 *    ephemeral range, which is how a *source* port collided with a listener.
 * 2. Each candidate is proven free by actually binding it before it is returned.
 *
 * The bind is released before the caller starts the relay, so this is not a
 * hard reservation — it is a liveness probe plus a band the kernel will not
 * allocate on its own. Give each suite its own disjoint band so two files in
 * the same run cannot probe into each other.
 */
export async function reserveTestPort(
  base: number,
  span: number,
  attempts = 40
): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = base + Math.floor(Math.random() * span);
    if (await isPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `reserveTestPort: no free port in [${base}, ${base + span}) after ${attempts} attempts`
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}
