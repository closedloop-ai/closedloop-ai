import { join } from "node:path";

/**
 * Module aliases every Storybook consumer of this repo's source needs.
 *
 * Two builders index the same story corpus and both must resolve it
 * identically: Storybook's Vite build (`main.ts`'s `viteFinal`, ISS-10257) and
 * the Vitest portable-stories sweep (`apps/storybook/vitest.config.ts`,
 * ISS-5287).
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
 * the builder's resolver and is main.ts's business.
 *
 * ORDER IS PART OF THE CONTRACT. Vite matches aliases in declaration order, so
 * the `@repo` catch-all is returned LAST and every more specific `@repo/*`
 * entry must be declared before it — including any a caller adds around this
 * map, which is why `main.ts` puts `@repo/design-system` ahead of the spread.
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
    // App-core stories consume API-owned display vocabularies directly from
    // source. Next's tsconfig-path resolver can otherwise rewrite these deep
    // imports to a relative module id that Storybook's Vite runtime cannot
    // load after HMR. Keep the Vite build and the portable-stories sweep on
    // the same package-root mapping.
    "@repo/api": join(repoRoot, "packages", "api"),
    "@repo/loops-api": join(repoRoot, "packages", "loops-api", "src"),
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

  // Review on PR #7270 (marisolashgrove): these three were hand-copied into both
  // `main.ts` and `vitest.config.ts`, which is the drift this module exists to
  // prevent. `cost` is consumed from source and resolved through package
  // `exports` by Next, so only the source-reading builders need them.
  // The catch-all stays last for the ordering contract above.
  aliases["@repo/cost"] = join(repoRoot, "packages", "cost", "src");
  aliases["@repo/document-schema"] = join(
    repoRoot,
    "packages",
    "document-schema",
    "src"
  );
  // apps/app/env.ts reads `@repo/realtime-contract/protocol`, whose `exports`
  // entry points into `src/`.
  aliases["@repo/realtime-contract"] = join(
    repoRoot,
    "packages",
    "realtime-contract",
    "src"
  );
  // packages/app/shared/realtime reads `@repo/realtime-client/*`, whose
  // `exports` entries point into `src/`.
  aliases["@repo/realtime-client"] = join(
    repoRoot,
    "packages",
    "realtime-client",
    "src"
  );
  // Surfaces mounts the live app's route components, which read Clerk.
  // Storybook has no Clerk instance, so `@clerk/nextjs` resolves to a
  // signed-in stand-in (./clerk-nextjs-mock.tsx). Subpaths first: the bare
  // key is a prefix alias. The two subpath mocks are apps/app's own.
  aliases["@clerk/nextjs/errors"] = join(
    repoRoot,
    "apps/app/vitest-mocks/clerk-nextjs-errors.ts"
  );
  aliases["@clerk/nextjs/server"] = join(
    repoRoot,
    "apps/app/vitest-mocks/clerk-nextjs-server.ts"
  );
  aliases["@clerk/nextjs"] = join(
    repoRoot,
    "apps/storybook/.storybook/clerk-nextjs-mock.tsx"
  );
  // The live document routes' editor waits on a Liveblocks room Storybook
  // cannot sync, so room ids resolve to none and the editor takes its
  // room-less branch (./collaboration-room-utils-mock.ts).
  aliases["@repo/collaboration/shared/room-utils"] = join(
    repoRoot,
    "apps/storybook/.storybook/collaboration-room-utils-mock.ts"
  );
  aliases["@repo"] = join(repoRoot, "packages");

  return aliases;
}
