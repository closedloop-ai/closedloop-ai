/**
 * ISS-5723: the launch-argument opt-out that moves this launch's FIXED loopback
 * listeners onto OS-assigned ephemeral ports, so two app instances can run at
 * once.
 *
 * The Electron E2E suite ran at `workers: 1`. Most of what a second worker would
 * collide on was already isolated: every launch gets its own `mkdtemp`
 * `--user-data-dir`, the e2e fixture servers bind port 0, and the gateway server
 * walks `PORT_PROBE_ORDER` until a candidate binds. Two listeners are not:
 *
 *   - the agent hook listener on `AGENT_MONITOR_PORT` (4820), and
 *   - the OTLP receiver on `DEFAULT_OTLP_RECEIVER_PORT` (4318),
 *
 * each of which binds ONE fixed port with no fallback. Both were observed bound
 * by an E2E-launched app, and both fail SOFT on `EADDRINUSE` — so a second worker
 * does not crash, it silently runs with agent capture off. That is a
 * non-deterministic flake in any spec that asserts on capture, not an honest
 * failure, which is exactly why the worker count could not simply be raised.
 *
 * Neither port may move in a real install: the hook commands baked into
 * `~/.claude/settings.json` POST to `127.0.0.1:4820`, and an OTel exporter
 * configured against this machine points at `127.0.0.1:4318`. So this is a
 * TEST-ONLY switch, and — like {@link E2E_NO_REVEAL_ARG} — deliberately an
 * app-level LAUNCH ARGUMENT rather than an env var: an env var can be inherited
 * into a real user's session, where it would take their agent capture off the
 * port their installed hooks already post to. A packaged build ignores it
 * outright, the same posture the reveal suppression takes.
 */

/** Binds this launch's fixed loopback listeners ephemerally. Unpackaged builds only. */
export const E2E_EPHEMERAL_LOOPBACK_PORTS_ARG =
  "--e2e-ephemeral-loopback-ports";

/**
 * `listen(0)` — the OS assigns a free port. Both listeners already report the
 * ADDRESS they bound rather than the port they asked for, so nothing downstream
 * has to learn about this.
 */
const EPHEMERAL_PORT = 0;

/**
 * The port a fixed loopback listener should bind for this launch: its real
 * default, or {@link EPHEMERAL_PORT} when this launch opted out of fixed ports.
 */
export function resolveLoopbackListenerPort(
  defaultPort: number,
  argv: readonly string[],
  options: { isPackaged: boolean }
): number {
  if (options.isPackaged) {
    return defaultPort;
  }
  return argv.includes(E2E_EPHEMERAL_LOOPBACK_PORTS_ARG)
    ? EPHEMERAL_PORT
    : defaultPort;
}
