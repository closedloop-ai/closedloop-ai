import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/nextjs-vite";
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
// Hoisted for the same reason: this runs once per module the builder touches.
const TS_SOURCE_PATTERN = /\.tsx?$/;
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
    // Renders the Docs page every story's `autodocs` tag asks for, and is what
    // makes the Controls table appear inside it.
    //
    // This was MISSING. Storybook 9 dissolved `addon-essentials`, which used to
    // carry docs, into separate packages, and nothing re-added this one. 1,405
    // of 1,484 entries were tagged `autodocs` and the built index contained
    // zero `type: "docs"` entries, so every one of those tags was inert: the
    // prop tables this Storybook's whole Controls effort produces had no page
    // to render on.
    getAbsolutePath("@storybook/addon-docs"),
    // Surfaces axe results per story in the Accessibility panel. The design
    // system already carries accessibility contracts in its component source;
    // this is what makes a violation visible while reviewing rather than only
    // in a later audit.
    getAbsolutePath("@storybook/addon-a11y"),
    // `addon-mcp` declares `addon-vitest` as a required peer and its preset
    // does not register without it, so this is a prerequisite rather than a
    // separate feature.
    getAbsolutePath("@storybook/addon-vitest"),
    // Serves an MCP endpoint from the dev server at /mcp so an agent can query
    // this Storybook for components, stories and their arg types instead of
    // grepping the repo. DEV ONLY: `storybook build` is a static export with no
    // server to answer on, so this never exists on the deployed URL.
    getAbsolutePath("@storybook/addon-mcp"),
    getAbsolutePath("@storybook/addon-themes"),
  ],
  // Vite rather than Webpack. `@storybook/addon-vitest` (and therefore
  // `@storybook/addon-mcp`, which requires it) refuses to run on the
  // Webpack-based `@storybook/nextjs`, and says so at boot.
  framework: {
    name: getAbsolutePath("@storybook/nextjs-vite"),
    options: {},
  },
  // `../../app/public` so the Screens layer can use the real brand assets the
  // app serves (logo.svg, logo-dark.svg, CL-SS3.png) rather than approximating
  // them. A screen that mocks up its own logo is showing something the product
  // does not contain, which is the whole failure mode the Screens layer exists
  // to catch.
  staticDirs: ["../public", "../../app/public"],
  typescript: {
    // The default `react-docgen` parser silently bails on several of this
    // repo's component files (tabs, badge, tooltip, toggle-group, textarea,
    // theme-submenu, ...), logging "Failed to parse ... with react-docgen" at
    // boot. A component with no docgen output gets no inferred argTypes, which
    // is why the Controls panel renders empty for those stories. The
    // TypeScript-backed parser reads the real prop types instead.
    // Carried over verbatim from the Webpack config on purpose. The Vite
    // builder runs a DIFFERENT docgen plugin behind this same setting, and the
    // entire Controls surface depends on it reading identically, so this
    // migration is checked by diffing every inferred prop before and after
    // rather than by assuming.
    reactDocgen: "react-docgen-typescript",
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      shouldRemoveUndefinedFromOptional: true,
      // The Vite docgen plugin builds a TypeScript program and skips any file
      // outside it. This app's tsconfig only covers `apps/storybook`, so on the
      // first Vite build every component in `packages/**` was silently skipped:
      // docgen fell from 644 components to 7, with no error. Supplying compiler
      // options directly (rather than a tsconfig path, which the plugin treats
      // as mutually exclusive) removes the include-list gate, and the globs
      // below reach the two workspaces that actually hold components.
      include: [
        "**/*.tsx",
        "**/*.ts",
        "../../packages/design-system/**/*.tsx",
        "../../packages/app/**/*.tsx",
        "../../apps/desktop/src/renderer/**/*.tsx",
      ],
      compilerOptions: {
        jsx: 4, // react-jsx
        esModuleInterop: true,
        skipLibCheck: true,
        allowJs: false,
        moduleResolution: 100, // bundler
        target: 99, // esnext
        strict: true,
      },
      // Without this every story inherits hundreds of DOM/React props.
      propFilter: (prop) =>
        prop.parent ? !NODE_MODULES_PATTERN.test(prop.parent.fileName) : true,
    },
  },
  viteFinal: (viteConfig) => {
    viteConfig.resolve ??= {};
    // @hookform/resolvers/zod imports zod/v4/core, but pnpm can hoist a
    // transitive zod@3 into the virtual store. Force this build to resolve zod
    // through this package's direct zod@4 dependency.
    viteConfig.resolve.alias = {
      ...(viteConfig.resolve.alias as Record<string, string>),
      // Shared with the Vitest portable-stories sweep so the two builders that
      // index this story corpus cannot drift (see ./module-aliases.ts).
      ...storybookModuleAliases(repoRoot),
      // Point at design-system SOURCE, not its `dist`. The package's exports
      // map sends consumers to `dist/*.js`, and the Vite builder then runs the
      // JavaScript docgen parser over compiled output: pointless, and fatal
      // here because `react-docgen` still requires Babel 7 while this repo
      // runs Babel 8. Reading `.tsx` instead means docgen uses the TypeScript
      // parser, which is the one the whole Controls surface was built on.
      //
      // It also decouples the Storybook build from `dist` being intact, which
      // has been its own source of confusing failures.
      "@closedloop-ai/design-system": join(repoRoot, "packages/design-system"),
      "@repo/design-system": join(repoRoot, "packages/design-system"),
      // Ported from `vitest.config.ts`, which hit these first and documents
      // why: these packages are consumed from source and Next resolves them
      // through package `exports`, so the Webpack build never needed them.
      // Vite does. Vite matches aliases in DECLARATION ORDER, so every
      // specific entry above must precede the `@repo` catch-all below.
      "@repo/cost": join(repoRoot, "packages/cost/src"),
      "@repo/crewd": join(repoRoot, "packages/crewd/src"),
      "@repo": join(repoRoot, "packages"),
      zod: zodPath,
    };
    // Storybook's Vite docgen plugin runs the JAVASCRIPT `react-docgen` parser
    // over every `.js` file in the graph, and `react-docgen@8` is incompatible
    // with the `@babel/core@8` this repo hoists: it calls `loadPartialConfig`
    // synchronously, which Babel 8 removed. Even react-docgen's latest still
    // declares `@babel/core: ^7`, so there is no version to upgrade to.
    //
    // Nothing here needs JS docgen. Every component whose props matter is
    // TypeScript, and `react-docgen-typescript` handles those. So the plugin is
    // constrained to TS sources rather than disabled, which keeps the Controls
    // surface intact and sidesteps the Babel incompatibility entirely.
    for (const plugin of viteConfig.plugins?.flat() ?? []) {
      const p = plugin as { name?: string; transform?: unknown };
      if (p?.name !== "storybook:react-docgen-plugin") {
        continue;
      }
      const original = p.transform as (
        this: unknown,
        code: string,
        id: string
      ) => unknown;
      p.transform = function transform(code: string, id: string) {
        if (!TS_SOURCE_PATTERN.test(id.split("?")[0])) {
          return null;
        }
        return original.call(this, code, id);
      };
    }

    // The Webpack config carried an `extensionAlias` mapping `.js` specifiers
    // onto their TypeScript sources. Vite resolves those itself for workspace
    // source files, so there is no equivalent to port; if one turns out to be
    // needed it will fail loudly at build rather than silently.
    return viteConfig;
  },
};

export default config;
