import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/nextjs";

const require = createRequire(import.meta.url);

/**
 * This function is used to resolve the absolute path of a package.
 * It is needed in projects that use Yarn PnP or are set up within a monorepo.
 */
const getAbsolutePath = (value: string) =>
  dirname(require.resolve(join(value, "package.json")));

const zodPath = getAbsolutePath("zod");
const loopsApiSrcPath = fileURLToPath(
  new URL("../../../packages/loops-api/src", import.meta.url)
);
const appSrcPath = fileURLToPath(new URL("../../app", import.meta.url));
const sharedPlatformSrcPath = fileURLToPath(
  new URL("../../../packages/shared-platform/src", import.meta.url)
);
const telemetryContractPath = fileURLToPath(
  new URL("../../../packages/telemetry-contract", import.meta.url)
);

const config: StorybookConfig = {
  stories: [
    "../stories/**/*.mdx",
    "../stories/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    // Shared app-core layer (FEA-1510): feature-slice stories live next to
    // their components in packages/app/<feature>/components/.
    "../../../packages/app/*/components/**/*.stories.@(ts|tsx)",
    // Desktop renderer boundary stories exercise Electron wrapper components
    // with deterministic preload fixtures while reusing the shared preview.
    "../../../apps/desktop/src/renderer/components/**/*.stories.@(ts|tsx)",
  ],
  addons: [
    getAbsolutePath("@chromatic-com/storybook"),
    getAbsolutePath("@storybook/addon-onboarding"),
    getAbsolutePath("@storybook/addon-themes"),
  ],
  framework: {
    name: getAbsolutePath("@storybook/nextjs"),
    options: {},
  },
  staticDirs: ["../public"],
  webpackFinal: (config) => {
    config.resolve ??= {};
    // @hookform/resolvers/zod imports zod/v4/core, but pnpm can hoist a
    // transitive zod@3 into the virtual store. Force Storybook's webpack build
    // to resolve zod through this package's direct zod@4 dependency.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@closedloop-ai/loops-api": loopsApiSrcPath,
      "@closedloop-ai/telemetry-contract/app": join(
        telemetryContractPath,
        "app.ts"
      ),
      "@closedloop-ai/telemetry-contract/app-exception-origin": join(
        telemetryContractPath,
        "app-exception-origin.ts"
      ),
      "@closedloop-ai/telemetry-contract/attributes": join(
        telemetryContractPath,
        "src",
        "attributes.ts"
      ),
      "@closedloop-ai/telemetry-contract/collector-tail-sampling-policy": join(
        telemetryContractPath,
        "collector-tail-sampling-policy.ts"
      ),
      "@closedloop-ai/telemetry-contract/emit": join(
        telemetryContractPath,
        "src",
        "emit.ts"
      ),
      "@closedloop-ai/telemetry-contract/gen-ai": join(
        telemetryContractPath,
        "src",
        "gen-ai.ts"
      ),
      "@closedloop-ai/telemetry-contract/ipc": join(
        telemetryContractPath,
        "ipc.ts"
      ),
      "@closedloop-ai/telemetry-contract/permission": join(
        telemetryContractPath,
        "permission.ts"
      ),
      "@closedloop-ai/telemetry-contract/resource": join(
        telemetryContractPath,
        "src",
        "resource.ts"
      ),
      "@closedloop-ai/telemetry-contract/schema-name": join(
        telemetryContractPath,
        "src",
        "schema-name.ts"
      ),
      "@closedloop-ai/telemetry-contract/schema-shape": join(
        telemetryContractPath,
        "src",
        "schema-shape.ts"
      ),
      "@closedloop-ai/telemetry-contract/span": join(
        telemetryContractPath,
        "src",
        "span.ts"
      ),
      "@closedloop-ai/telemetry-contract/sync": join(
        telemetryContractPath,
        "sync.ts"
      ),
      "@closedloop-ai/telemetry-contract/test-fixtures": join(
        telemetryContractPath,
        "src",
        "test-fixtures.ts"
      ),
      "@closedloop-ai/telemetry-contract/validate": join(
        telemetryContractPath,
        "src",
        "validate.ts"
      ),
      "@repo/shared-platform/detection-store": join(
        sharedPlatformSrcPath,
        "detection-store.ts"
      ),
      "@repo/shared-platform/gateway-constants": join(
        sharedPlatformSrcPath,
        "gateway-constants.ts"
      ),
      "@repo/shared-platform/gateway-dispatch": join(
        sharedPlatformSrcPath,
        "gateway-dispatch.ts"
      ),
      "@repo/shared-platform/gateway-fetch-shim": join(
        sharedPlatformSrcPath,
        "gateway-fetch-shim.ts"
      ),
      "@repo/shared-platform/gateway-probe": join(
        sharedPlatformSrcPath,
        "gateway-probe.ts"
      ),
      "@repo/shared-platform/keyless-telemetry": join(
        sharedPlatformSrcPath,
        "keyless-telemetry.ts"
      ),
      "@repo/shared-platform/relay-request-model": join(
        sharedPlatformSrcPath,
        "relay-request-model.ts"
      ),
      "@repo/shared-platform/routing-store": join(
        sharedPlatformSrcPath,
        "routing-store.ts"
      ),
      "@repo/shared-platform/storage": join(
        sharedPlatformSrcPath,
        "storage.ts"
      ),
      "@repo/shared-platform/types": join(sharedPlatformSrcPath, "types.ts"),
      "@": appSrcPath,
      zod: zodPath,
    };
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default config;
