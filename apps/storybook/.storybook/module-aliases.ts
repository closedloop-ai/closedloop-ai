import { join } from "node:path";

/**
 * Module aliases every Storybook consumer of this repo's source needs.
 *
 * Two builders index the same story corpus and both must resolve it
 * identically: Storybook's webpack build (`main.ts`'s `webpackFinal`) and the
 * Vitest portable-stories sweep (`apps/storybook/vitest.config.ts`, ISS-5287).
 * They lived as one inline map until the sweep existed; a second hand-copied map
 * would drift, and the failure mode is quiet — the sweep would just stop being
 * able to import some stories while still reporting green on the rest.
 *
 * Deliberately free of `import.meta`: Storybook loads `main.ts` through its own
 * transpile step, so `import.meta.dirname` is not reliably available there even
 * though `import.meta.url` is. Callers compute their own repo root and pass it
 * in.
 *
 * `zod` is NOT here — that alias exists only to defeat a pnpm hoisting quirk in
 * webpack's resolver and is main.ts's business.
 */

/** Subpaths of `@closedloop-ai/telemetry-contract` that live at its root. */
const TELEMETRY_CONTRACT_ROOT_MODULES = [
  "app",
  "app-exception-origin",
  "collector-tail-sampling-policy",
  "ipc",
  "permission",
  "sync",
] as const;

/** Subpaths of `@closedloop-ai/telemetry-contract` that live under `src/`. */
const TELEMETRY_CONTRACT_SRC_MODULES = [
  "attributes",
  "emit",
  "gen-ai",
  "resource",
  "schema-name",
  "schema-shape",
  "span",
  "test-fixtures",
  "validate",
] as const;

/** Subpaths of `@repo/shared-platform`, all under `src/`. */
const SHARED_PLATFORM_MODULES = [
  "detection-store",
  "gateway-constants",
  "gateway-dispatch",
  "gateway-fetch-shim",
  "gateway-probe",
  "keyless-telemetry",
  "relay-request-model",
  "routing-store",
  "storage",
  "types",
] as const;

/**
 * @param repoRoot Absolute path to the monorepo root.
 */
export function storybookModuleAliases(
  repoRoot: string
): Record<string, string> {
  const telemetryContractPath = join(
    repoRoot,
    "packages",
    "telemetry-contract"
  );
  const sharedPlatformSrcPath = join(
    repoRoot,
    "packages",
    "shared-platform",
    "src"
  );

  const aliases: Record<string, string> = {
    "@closedloop-ai/loops-api": join(repoRoot, "packages", "loops-api", "src"),
    "@": join(repoRoot, "apps", "app"),
  };

  for (const moduleName of TELEMETRY_CONTRACT_ROOT_MODULES) {
    aliases[`@closedloop-ai/telemetry-contract/${moduleName}`] = join(
      telemetryContractPath,
      `${moduleName}.ts`
    );
  }
  for (const moduleName of TELEMETRY_CONTRACT_SRC_MODULES) {
    aliases[`@closedloop-ai/telemetry-contract/${moduleName}`] = join(
      telemetryContractPath,
      "src",
      `${moduleName}.ts`
    );
  }
  for (const moduleName of SHARED_PLATFORM_MODULES) {
    aliases[`@repo/shared-platform/${moduleName}`] = join(
      sharedPlatformSrcPath,
      `${moduleName}.ts`
    );
  }

  return aliases;
}
