import os from "node:os";

/**
 * Overrides the OS hostname as the name this Desktop reports for its device,
 * the way the `CL_*_ORIGIN` overrides replace the default origins
 * (`src/shared/contracts.ts`). The vibe profile sets it (ISS-12135) so its
 * Desktop registers as the seeded machine rather than the operator's own.
 */
export const DESKTOP_MACHINE_NAME_ENV = "CL_MACHINE_NAME";

/** The machine name every registration, sign-in and local listing reports. */
export function resolveDesktopMachineName(
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env[DESKTOP_MACHINE_NAME_ENV]?.trim();
  return override ? override : os.hostname();
}
