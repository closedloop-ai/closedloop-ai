import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/nextjs";
import { storybookModuleAliases } from "./module-aliases";

const require = createRequire(import.meta.url);

/**
 * This function is used to resolve the absolute path of a package.
 * It is needed in projects that use Yarn PnP or are set up within a monorepo.
 */
const getAbsolutePath = (value: string) =>
  dirname(require.resolve(join(value, "package.json")));

const zodPath = getAbsolutePath("zod");
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

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
      // Shared with the Vitest portable-stories sweep so the two builders that
      // index this story corpus cannot drift (see ./module-aliases.ts).
      ...storybookModuleAliases(repoRoot),
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
