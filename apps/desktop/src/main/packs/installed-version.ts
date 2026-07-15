/**
 * @file installed-version.ts
 * @description FEA-2923: pure resolution of a pack's installed version from its
 * local `agent_packs` inventory detail. Lives in its own module (no Electron
 * imports) so it is unit-testable outside the Electron runtime.
 */

import type { InstalledPackDetail } from "../../shared/agent-db-contract.js";

/**
 * Resolve the installed version of a pack from its inventory detail.
 *
 * Returns null when the pack is not installed (so the auto-install reconciler
 * treats it as "needs install"). A pack that IS installed but carries no version
 * string resolves to the `"installed"` sentinel so the reconciler sees it as
 * present and does not re-install it. When multiple installs report differing
 * versions, the first concrete (truthy) version wins.
 */
export function resolveInstalledPackVersion(
  detail: InstalledPackDetail | null
): string | null {
  if (!detail) {
    return null;
  }
  const version = detail.installs
    .map((install) => install.version)
    .find((value): value is string => Boolean(value));
  return version ?? "installed";
}
