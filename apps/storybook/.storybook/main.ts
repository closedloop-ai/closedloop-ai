import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { StorybookConfig } from "@storybook/nextjs-vite";
import ts from "typescript6";
import { mergeAlias, type Plugin, type PluginOption } from "vite";
import { storybookModuleAliases } from "./module-aliases";
import {
  DOCGEN_TS_PLUGIN_NAME,
  type DocgenScope,
  precomputeDocgen,
} from "./precompute-docgen";

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
// The Vite docgen plugin is matched by name; see the throw in `viteFinal`.
const DOCGEN_PLUGIN_NAME = "storybook:react-docgen-plugin";
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
// Shared by the docgen plugin options and `precomputeDocgen`, which replays
// the plugin's own root glob and transform filter from them.
const DOCGEN_SCOPE: DocgenScope = {
  include: [
    "**/*.tsx",
    "**/*.ts",
    "../../packages/design-system/**/*.tsx",
    "../../packages/app/**/*.tsx",
    "../../apps/desktop/src/renderer/**/*.tsx",
  ],
  // ISS-12145: these globs are also the roots of the TypeScript program the
  // plugin holds in memory for the whole transform phase. It globs them from
  // apps/storybook with `exclude` as glob's `ignore`, which glob matches
  // against paths relative to apps/storybook, and `**` does not cross `..`.
  // So the default `**/*.stories.tsx` kept every story in packages/app and
  // the desktop renderer as a root, and test files were never excluded.
  // Docgen transforms none of these files; absolute patterns drop them.
  // Not `join(repoRoot, …)`: vercel-hosting-contract.test.ts reads every
  // such call as a path the build reads and checks that turbo hashes it.
  exclude: [
    "**/*.stories.tsx",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/__tests__/**",
  ].map((pattern) => `${repoRoot}${pattern}`),
};

const config: StorybookConfig = {
  stories: [
    "../stories/**/*.mdx",
    "../stories/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    // Shared app-core layer (FEA-1510): feature-slice stories live next to
    // their components in packages/app/<feature>/components/. The second
    // pattern is the versioned-slice case (`settings/v2/components/`): a
    // feature mid-migration nests its components one level deeper, and a story
    // under it matched neither pattern — Storybook indexed nothing and the
    // sweep ran nothing, with no red anywhere to say the story existed.
    "../../../packages/app/*/components/**/*.stories.@(ts|tsx)",
    "../../../packages/app/*/*/components/**/*.stories.@(ts|tsx)",
    // Desktop renderer boundary stories exercise Electron wrapper components
    // with deterministic preload fixtures while reusing the shared preview.
    "../../../apps/desktop/src/renderer/components/**/*.stories.@(ts|tsx)",
  ],
  addons: [
    getAbsolutePath("@chromatic-com/storybook"),
    getAbsolutePath("@storybook/addon-themes"),
    // ISS-9308: every `tags: ["autodocs"]` story already relies on this to
    // render a real Docs page — without it, a component's written
    // state-matrix/accessibility reasoning exists only in source, invisible
    // to anyone reviewing in the browser.
    getAbsolutePath("@storybook/addon-docs"),
    // Surfaces axe results per story in the Accessibility panel. The design
    // system already carries accessibility contracts in its component source;
    // this is what makes a violation visible while reviewing rather than only
    // in a later audit.
    getAbsolutePath("@storybook/addon-a11y"),
    // `addon-mcp` declares `addon-vitest` as a required peer and its preset
    // does not register without it. It is also what runs a story test for
    // `addon-mcp`: it starts the browser-mode `storybookTest` project in
    // `vitest.config.ts` (ISS-10397) from this dev server.
    getAbsolutePath("@storybook/addon-vitest"),
    // Serves an MCP endpoint from the dev server at /mcp so an agent can query
    // this Storybook for components, stories and their arg types instead of
    // grepping the repo. DEV ONLY: `storybook build` is a static export with no
    // server to answer on, so this never exists on the deployed URL.
    // `pnpm --filter storybook test:mcp` (scripts/mcp-handshake.mjs) boots the
    // dev server and checks the tool list, the docs tools and one real test run.
    {
      name: getAbsolutePath("@storybook/addon-mcp"),
      options: {
        // The addon advertises its test tool only when this is on AND
        // addon-vitest is present; the browser-mode project behind it is what
        // makes the advertised tool actually run (review on PR #7270, whitlockk).
        toolsets: { test: true },
      },
    },
  ],
  // Review on PR #7270 (whitlockk): `addon-mcp`'s `docs-list` / `docs-show` tools
  // and the hosted `manifests/components.json` endpoint both read from this
  // manifest. `nextjs-vite` does not turn it on by default the way some
  // frameworks do — without this flag those tools have no component API to
  // answer from, not a wiring bug in the addon itself.
  features: {
    componentsManifest: true,
  },
  // Vite rather than Webpack. `@storybook/addon-vitest` (and therefore
  // `@storybook/addon-mcp`, which requires it) refuses to run on the
  // Webpack-based `@storybook/nextjs`, and says so at boot.
  framework: {
    name: getAbsolutePath("@storybook/nextjs-vite"),
    options: {},
  },
  // `../public` for this Storybook's own assets. The second entry is what lets
  // the Screens/Surfaces layer render the REAL brand assets rather than three
  // broken images (review on PR #7288, whitlockk): `logo.svg`, `logo-dark.svg` and
  // `sign-in-screenshot.png` live only in `apps/app/public`, and referencing them from a
  // Surface story served nothing. Mounted under its own `/app-public` prefix
  // rather than at the root so `favicon.ico` — the one filename both
  // directories carry, with different bytes — cannot resolve ambiguously
  // depending on which builder (dev middleware vs. static copy) is serving.
  staticDirs: ["../public", { from: "../../app/public", to: "/app-public" }],
  typescript: {
    // Without this the default `react-docgen` parser silently drops any prop
    // whose type it cannot statically resolve, which is most of what this
    // design system actually uses: discriminated unions, generics, and types
    // imported from another package. A component with no docgen output gets no
    // inferred argTypes, which is why the Controls panel renders empty for
    // those stories. The TypeScript-backed parser reads the real prop types
    // instead.
    //
    // Carried over verbatim from the Webpack config on purpose. The Vite
    // builder runs a DIFFERENT docgen plugin behind this same setting, and the
    // entire Controls surface depends on it reading identically, so this
    // migration is checked by diffing every inferred prop before and after
    // rather than by assuming.
    //
    // This plugin only works with `typescript6` (see this app's package.json,
    // where `typescript` is aliased to `npm:@typescript/typescript6@...`, not
    // the repo's normal typescript@7). Two failures, in order:
    // 1. Against typescript@7 the plugin crashes at boot reading `ts.JsxEmit`,
    //    which does not exist on that version's public export surface at all.
    // 2. Against typescript6, the `compilerOptions` below (jsx/moduleResolution/
    //    target) have to be typescript6's own ENUM VALUES, not the string
    //    form ("react-jsx" etc.) — passing strings gets "target is a string
    //    value; tsconfig JSON must be parsed with
    //    parseJsonSourceFileConfigFileContent... before passing to
    //    createProgram", because this plugin hands compilerOptions straight to
    //    `ts.createProgram` without going through the JSON-config parser that
    //    would normally translate strings to enums.
    // Scoped to this one workspace package deliberately: nothing else in the
    // repo runs a `tsc` typecheck through `apps/storybook`'s own `typescript`
    // resolution, so this alias cannot change what any other package's
    // typecheck sees.
    reactDocgen: "react-docgen-typescript",
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      shouldRemoveUndefinedFromOptional: true,
      // The Vite docgen plugin builds a TypeScript program and skips any file
      // outside it. This app's tsconfig only covers `apps/storybook`, so on the
      // first Vite build every component in `packages/**` was silently skipped:
      // docgen fell from hundreds of components to a handful, with no error.
      // Supplying compiler options directly (rather than a tsconfig path, which
      // the plugin treats as mutually exclusive) removes the include-list gate,
      // and the globs below reach the three workspaces that actually hold
      // components.
      include: DOCGEN_SCOPE.include,
      exclude: DOCGEN_SCOPE.exclude,
      // Review on PR #7270 (marisolashgrove): these are typescript6's own enum
      // members rather than the raw numbers they compile to, so a value that
      // shifts on a bump breaks loudly here instead of silently meaning
      // something else.
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        skipLibCheck: true,
        allowJs: false,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
        strict: true,
      },
      // Without this every story inherits hundreds of DOM/React props.
      propFilter: (prop) =>
        prop.parent ? !NODE_MODULES_PATTERN.test(prop.parent.fileName) : true,
    },
  },
  viteFinal: (viteConfig, options) => {
    viteConfig.resolve ??= {};
    // @hookform/resolvers/zod imports zod/v4/core, but pnpm can hoist a
    // transitive zod@3 into the virtual store. Force this build to resolve zod
    // through this package's direct zod@4 dependency.
    //
    // `resolve.alias` is Vite's own `AliasOptions` — a plain object OR an
    // array of `{find, replacement}` entries — and a bare
    // `as Record<string, string>` cast here used to assume the object form.
    // If a Storybook/nextjs-vite version ever hands back the array form
    // instead, spreading it as an object turns it into `{"0": {...}, "1":
    // {...}}`, silently replacing every framework alias underneath it
    // (next/image, next/font, the React aliasing) with junk keys. `mergeAlias`
    // is Vite's own utility for merging two `AliasOptions` of either shape —
    // used internally by `mergeConfig` for exactly this key — so it takes the
    // normalization question out of this file's hands. `b` (our overrides)
    // wins a same-key collision and is checked first in the array form, same
    // priority the object spread below always had.
    viteConfig.resolve.alias = mergeAlias(viteConfig.resolve.alias, {
      // Point at design-system SOURCE, not its `dist`. The package's exports
      // map sends consumers to `dist/*.js`, and the Vite builder then runs the
      // JavaScript docgen parser over compiled output: pointless, and fatal
      // here because `react-docgen` still requires Babel 7 while this repo
      // runs Babel 8. Reading `.tsx` instead means docgen uses the TypeScript
      // parser, which is the one the whole Controls surface was built on.
      //
      // It also decouples the Storybook build from `dist` being intact, which
      // has been its own source of confusing failures.
      //
      // Declared BEFORE the shared map because that map ends with the `@repo`
      // catch-all and Vite matches aliases in declaration order.
      "@repo/design-system": join(repoRoot, "packages/design-system"),
      "@closedloop-ai/design-system": join(repoRoot, "packages/design-system"),
      // Ported from `vitest.config.ts`, which hit this first and documents why
      // in full (Surfaces/PRDs, Surfaces/Implementation Plans): `@repo/
      // analytics/client`'s top-level `import ... from "@posthog/next"` fails
      // to resolve under this Vite build the same way it does under Vitest —
      // same extensionless re-export, same fix, reusing `apps/app`'s own
      // existing mock rather than a third copy.
      "@posthog/next": join(repoRoot, "apps/app/vitest-mocks/posthog-next.tsx"),
      // Shared with the Vitest portable-stories sweep so the two builders that
      // index this story corpus cannot drift (see ./module-aliases.ts). Carries
      // `@repo/cost` and the `@repo` catch-all, in that order.
      ...storybookModuleAliases(repoRoot),
      zod: zodPath,
    });
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
    let docgenPluginPatched = false;
    for (const plugin of viteConfig.plugins?.flat() ?? []) {
      const p = plugin as { name?: string; transform?: unknown };
      if (p?.name !== DOCGEN_PLUGIN_NAME) {
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
      docgenPluginPatched = true;
    }
    // Review on PR #7270 (tamsinb): the match above is a plugin-name string,
    // so an upstream rename would silently stop filtering and hand every `.js`
    // file back to the Babel-8-incompatible JS docgen parser — the exact crash
    // this constraint exists to prevent. Fail at config time instead.
    if (!docgenPluginPatched) {
      throw new Error(
        `Storybook's Vite config no longer contains a plugin named "${DOCGEN_PLUGIN_NAME}". ` +
          "The react-docgen JS-parser constraint in apps/storybook/.storybook/main.ts is no longer " +
          "being applied; find the plugin's new name and update DOCGEN_PLUGIN_NAME."
      );
    }

    viteConfig.plugins ??= [];
    viteConfig.plugins.push(releaseDocgenHeap());
    if (options.configType === "PRODUCTION") {
      viteConfig.plugins.push(
        precomputeDocgen(
          findDocgenTypescriptPlugin(viteConfig.plugins),
          DOCGEN_SCOPE,
          forceMemoryReducingGc
        )
      );
    }

    // The Webpack config carried an `extensionAlias` mapping `.js` specifiers
    // onto their TypeScript sources. Vite resolves those itself for workspace
    // source files, so there is no equivalent to port; if one turns out to be
    // needed it will fail loudly at build rather than silently.
    return viteConfig;
  },
};

export default config;

// ISS-11753 (the ISS-10991 render stall): docgen's TypeScript program leaves
// the V8 heap at ~4 GiB committed, of which under 1 GiB is still live once the
// docgen plugin tears down at `buildEnd`. V8 keeps the rest resident unless it
// happens to run a memory-reducing GC, and Rolldown's native chunk rendering
// then stacks on top of it inside Vercel's 8 GB build container. `last-resort`
// is that memory-reducing GC, forced before rendering starts.
function releaseDocgenHeap(): Plugin {
  return {
    name: "closedloop:release-docgen-heap",
    renderStart() {
      forceMemoryReducingGc();
    },
  };
}

function forceMemoryReducingGc(): void {
  // `setFlagsFromString` may do nothing; then `gc` is undefined and the build
  // goes on without the GC rather than failing on it.
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("globalThis.gc");
  setFlagsFromString("--no-expose-gc");
  if (typeof gc === "function") {
    gc({ type: "major", execution: "sync", flavor: "last-resort" });
  }
}

// Same reasoning as the `DOCGEN_PLUGIN_NAME` throw: a renamed plugin must fail
// the build, not silently bring the transform-phase OOM back (ISS-12676).
function findDocgenTypescriptPlugin(plugins: PluginOption[]): Plugin {
  const docgen = plugins
    .flat()
    .find(
      (plugin): plugin is Plugin =>
        (plugin as Plugin | null)?.name === DOCGEN_TS_PLUGIN_NAME
    );
  if (!docgen) {
    throw new Error(
      `Storybook's Vite config no longer contains a plugin named "${DOCGEN_TS_PLUGIN_NAME}". ` +
        "apps/storybook/.storybook/precompute-docgen.ts can no longer run docgen ahead of " +
        "the transform phase; find the plugin's new name and update DOCGEN_TS_PLUGIN_NAME."
    );
  }
  return docgen;
}
