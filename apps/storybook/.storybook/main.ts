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

// Hoisted per biome's useTopLevelRegex: propFilter runs once per prop per
// component, so re-compiling this literal inside it is measurable.
const NODE_MODULES_PATTERN = /node_modules/;
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
    // Surfaces axe results per story in the Accessibility panel. The design
    // system already carries accessibility contracts in its component source;
    // this is what makes a violation visible while reviewing rather than only
    // in a later audit.
    getAbsolutePath("@storybook/addon-a11y"),
    getAbsolutePath("@storybook/addon-themes"),
  ],
  framework: {
    name: getAbsolutePath("@storybook/nextjs"),
    options: {},
  },
  staticDirs: ["../public"],
  typescript: {
    // The default `react-docgen` parser silently bails on several of this
    // repo's component files (tabs, badge, tooltip, toggle-group, textarea,
    // theme-submenu, ...), logging "Failed to parse ... with react-docgen" at
    // boot. A component with no docgen output gets no inferred argTypes, which
    // is why the Controls panel renders empty for those stories. The
    // TypeScript-backed parser reads the real prop types instead.
    reactDocgen: "react-docgen-typescript",
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      shouldRemoveUndefinedFromOptional: true,
      // Without this every story inherits hundreds of DOM/React props.
      propFilter: (prop) =>
        prop.parent ? !NODE_MODULES_PATTERN.test(prop.parent.fileName) : true,
    },
  },
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
