import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createFilter, type Plugin } from "vite";

// ISS-12676: the `prototypes` production build of 2026-10-17 (green
// `ec35f211fc`) was OOM-killed inside `[plugin vite:react-docgen-typescript]`,
// the transform-phase ceiling ISS-11753 left open. The docgen plugin builds one
// TypeScript program (~5,800 source files, ~1.5 GB of V8 heap) at
// `configResolved` and holds it for the whole transform phase, so it peaks on
// top of the module graph the bundler builds alongside it.
//
// This runs every docgen transform in `buildStart`, before the bundler loads a
// module, then tears the program down and serves the stored results during the
// real transform phase. The program and the module graph no longer coexist.
// Production builds only; `storybook dev` keeps the plugin's own HMR path.
export const DOCGEN_TS_PLUGIN_NAME = "vite:react-docgen-typescript";

export type DocgenScope = { include: string[]; exclude: string[] };

export type GlobSync = (
  pattern: string,
  options: { absolute: boolean; cwd: string; ignore: string[]; nodir: boolean }
) => string[];

type DocgenTransform = (this: unknown, code: string, id: string) => unknown;

// What the plugin returned for a program root, reduced to the part that does
// not depend on the source text: `generateDocgenCodeBlock` only ever appends
// a block after the source (or returns the source unchanged), so the block is
// replayed onto whatever source the real transform receives.
type Precomputed = { append: string } | "source" | null;

export function precomputeDocgen(
  docgen: Plugin,
  scope: DocgenScope,
  releaseHeap: () => void
): Plugin {
  const original = docgen.transform;
  if (typeof original !== "function") {
    throw new Error(
      `${DOCGEN_TS_PLUGIN_NAME} no longer exposes a plain transform function; ` +
        "apps/storybook/.storybook/precompute-docgen.ts cannot precompute its output."
    );
  }
  const transformDocgen = original as DocgenTransform;
  // The plugin filters with `createFilter(include, exclude)`; same call here.
  const transforms = createFilter(scope.include, scope.exclude);
  const results = new Map<string, Precomputed>();
  const warned = new Set<string>();
  let root = process.cwd();
  let ready = false;

  // Not a program root: the plugin returns the source unchanged and warns
  // once per file. The warning is kept word for word because the Vercel build
  // scan reads its `[plugin vite:react-docgen-typescript]` prefix as the
  // transform-phase marker (`DOCGEN_STEP`, ISS-12103); `this` here is the
  // plugin's own context, so Vite prints the same prefix.
  const warnOutsideProgram = (context: unknown, fileId: string) => {
    if (warned.has(fileId)) {
      return;
    }
    warned.add(fileId);
    (context as { warn: (message: string) => void }).warn(
      `Skipping docgen for "${fileId}" because it is not included in the active TypeScript project.`
    );
  };

  const replay = function transform(
    this: unknown,
    code: string,
    id: string
  ): unknown {
    if (!ready) {
      return transformDocgen.call(this, code, id);
    }
    const file = id.split("?", 1)[0];
    if (!transforms(file)) {
      return;
    }
    const fileId = resolve(file);
    const result = results.get(fileId);
    if (result === undefined) {
      warnOutsideProgram(this, fileId);
      return code;
    }
    if (result === "source") {
      return code;
    }
    if (result === null) {
      return null;
    }
    return {
      code: `${code}${code.endsWith("\n") ? "" : "\n"}${result.append}`,
      map: null,
    };
  };
  docgen.transform = replay as Plugin["transform"];

  return {
    name: "closedloop:precompute-docgen",
    configResolved(resolvedConfig) {
      root = resolvedConfig.root;
    },
    async buildStart() {
      for (const file of inDocgenOrder(docgenRootFiles(scope, root))) {
        const code = await readFile(file, "utf8");
        const result = await transformDocgen.call(this, code, file);
        results.set(file, toPrecomputed(file, code, result));
      }
      const teardown = docgen.buildEnd;
      if (typeof teardown === "function") {
        (teardown as (this: unknown) => void).call(this);
      }
      releaseHeap();
      ready = true;
    },
  };
}

// The plugin roots its program at `globSync(include, { cwd: root, ignore:
// exclude })` with the `glob` it depends on (ISS-12145), so the roots are
// replayed with that same copy rather than this app's own.
export function docgenRootFiles(scope: DocgenScope, root: string): string[] {
  const globSync = docgenPluginGlob();
  const files = new Set<string>();
  for (const pattern of scope.include) {
    for (const file of globSync(pattern, {
      absolute: true,
      cwd: root,
      ignore: scope.exclude,
      nodir: true,
    })) {
      files.add(resolve(file));
    }
  }
  return [...files].sort();
}

// The plugin is a dependency of `@storybook/react-vite`, not of this app, and
// exports no `require` entry, so its directory is found on the lookup path
// Node would walk from `@storybook/react-vite`.
export function docgenPluginGlob(): GlobSync {
  const requireHere = createRequire(import.meta.url);
  const reactVite = createRequire(
    requireHere.resolve("@storybook/nextjs-vite/package.json")
  ).resolve("@storybook/react-vite/package.json");
  const pluginDir = createRequire(reactVite)
    .resolve.paths(DOCGEN_TS_PLUGIN_PACKAGE)
    ?.map((dir) => join(dir, DOCGEN_TS_PLUGIN_PACKAGE))
    .find((dir) => existsSync(join(dir, "package.json")));
  if (!pluginDir) {
    throw new Error(`${DOCGEN_TS_PLUGIN_PACKAGE} is not installed`);
  }
  const glob: { globSync: GlobSync } = createRequire(
    join(pluginDir, "package.json")
  )("glob");
  return glob.globSync;
}

function toPrecomputed(
  file: string,
  code: string,
  result: unknown
): Precomputed {
  if (result === null || result === undefined) {
    return null;
  }
  if (result === code) {
    return "source";
  }
  const output = (result as { code?: unknown }).code;
  const prefix = `${code}${code.endsWith("\n") ? "" : "\n"}`;
  if (typeof output === "string" && output.startsWith(prefix)) {
    return { append: output.slice(prefix.length) };
  }
  throw new Error(
    `${DOCGEN_TS_PLUGIN_NAME} returned output for "${file}" that is not the source ` +
      "with a docgen block appended; apps/storybook/.storybook/precompute-docgen.ts " +
      "cannot replay it."
  );
}

// A union's members come out in the order the checker first created each
// member type, so the order files are checked in decides the option order a
// Controls select shows. The plugin's own order is the bundler's, which
// already differs between two builds of the same commit (Badge's `variant`
// did on 2026-10-19). Checking the design system first keeps its components'
// own declarations ahead of the files that reuse their values, and the order
// is now the same on every build.
function inDocgenOrder(files: string[]): string[] {
  const rank = (file: string) => {
    const index = DOCGEN_ORDER.findIndex((dir) => file.includes(dir));
    return index === -1 ? DOCGEN_ORDER.length : index;
  };
  // `files` is already sorted and `sort` is stable, so each group keeps it.
  return [...files].sort((a, b) => rank(a) - rank(b));
}

const DOCGEN_TS_PLUGIN_PACKAGE =
  "@joshwooding/vite-plugin-react-docgen-typescript";
const DOCGEN_ORDER = [
  "/packages/design-system/",
  "/packages/app/",
  "/apps/desktop/",
];
