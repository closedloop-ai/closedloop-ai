import type { MemberPackInstaller } from "../../server/operations/member-pack-install.js";

/**
 * FEA-4082: member self-service pack install pushed cloud→relay→node.
 *
 * Forwards to the dashboard runtime's vetted `streamRun` install path (same
 * trust model as the renderer catalog-install / auto-distribution installer).
 * Reports not-started while the runtime is not yet wired, so a dispatch that
 * races startup fails cleanly rather than throwing.
 *
 * Extracted from `app.ts` (ISS-5369) so the gateway wiring is a named,
 * testable unit instead of an inline closure inside a 30-argument call.
 */
export function createGatewayPackInstaller(
  getRuntime: () => { installPack: MemberPackInstaller } | null | undefined
): MemberPackInstaller {
  return (packId, harness) => {
    const runtime = getRuntime();
    if (!runtime) {
      return Promise.resolve({
        started: false,
        error: {
          code: "ERUNTIME_UNAVAILABLE",
          message: "pack install runtime not ready",
        },
      });
    }
    return runtime.installPack(packId, harness);
  };
}
