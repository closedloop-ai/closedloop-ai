import { withoutTracerPreload } from "../../../../../scripts/tracer-preload-tokens.mjs";
import { isolatedHarnessHomes } from "../../helpers/isolated-harness-homes";

/**
 * The `browser-bridge-sidecar.spec.ts` launcher's environment without
 * dd-trace's CI preload.
 *
 * ISS-10943: merge-group and scheduled runs set `NODE_OPTIONS` to
 * `-r dd-trace/ci/init`. `_electron.launch` deletes `NODE_OPTIONS` for every
 * other Electron this suite starts, but this host is the launcher's child and
 * inherits the launcher's env. Loaded into it, dd-trace's Electron integration
 * wraps `ipcRenderer.send`, and the host's first `desktop:renderer-live-db-idle`
 * send aborts the renderer in V8 (`Isolate::PushStackTraceAndDie`). That drop
 * is the "host disconnected" / "host is unavailable" failure at the mirrored
 * read.
 */
export function launcherEnv(root: string): NodeJS.ProcessEnv {
  return withoutTracerPreload({
    ...process.env,
    ...isolatedHarnessHomes(root),
  });
}
