import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { type Plugin, resolveConfig } from "vite";
import { describe, test } from "vitest";
import { z } from "zod";

// ISS-10358 — React Compiler has no runtime failure mode: a renderer built
// without it still renders, only without the automatic memoization. The Vite 8
// upgrade proved that — plugin-react 6 ignored the `babel` key this config
// carried the compiler in, and every suite and the e2e stayed green while the
// shipped bundle lost every `react/compiler-runtime` import.
//
// So this resolves the REAL renderer config the way `vite build` does and pushes
// a component through the client environment's Babel plugin. It pins the Babel
// compiler carrier, its preset, and the id filter Rolldown applies natively
// during a build — a correctly configured compiler that no renderer file reaches
// is the same everything-present-nothing-running failure as the bug above.

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

const RENDERER_CONFIG_PATH = path.join(desktopDir, "vite.renderer.config.ts");
const CLIENT_ENVIRONMENT = "client";
const BABEL_PLUGIN_NAME = "@rolldown/plugin-babel";

const COMPONENT_FIXTURE_ID = path.join(
  desktopDir,
  "src/renderer/react-compiler-guard-fixture.tsx"
);
const COMPONENT_FIXTURE_SOURCE = `export function Greeting({ name }: { name: string }) {
  const message = \`Hello, \${name}\`;
  return <p>{message}</p>;
}
`;

/** React 19's runtime; a 17/18 target imports `react-compiler-runtime` instead. */
const REACT_19_COMPILER_RUNTIME_IMPORT =
  /from\s*["']react\/compiler-runtime["']/;

const transformResultSchema = z.object({ code: z.string() });

/** A real renderer module Rolldown feeds the plugin during a build. */
const RENDERER_ENTRY_ID = path.join(desktopDir, "src/renderer/App.tsx");
/** A vendor path the plugin's own exclude arm has to drop. */
const VENDOR_ID = path.join(desktopDir, "node_modules/react/index.js");

const idPatternsSchema = z
  .union([z.instanceof(RegExp), z.array(z.instanceof(RegExp))])
  .optional();

// `configResolved` assigns the filter Rolldown matches ids against, so it is
// readable off the resolved plugin. Non-strict: the hook also carries `handler`.
const transformHookSchema = z.object({
  filter: z
    .object({
      id: z
        .object({ include: idPatternsSchema, exclude: idPatternsSchema })
        .optional(),
    })
    .optional(),
});

// @rolldown/plugin-babel's `this.error()` call on a Babel failure passes a
// plain object (message/loc/pos/cause/pluginCode), never an Error.
const pluginErrorPayloadSchema = z.object({
  message: z.string().min(1).optional(),
});

describe("vite.renderer.config.ts React Compiler", () => {
  test("the client build runs components through React Compiler targeting React 19", async () => {
    const config = await resolveConfig(
      { configFile: RENDERER_CONFIG_PATH },
      "build",
      "production",
      "production"
    );
    const clientPlugins = config.environments[CLIENT_ENVIRONMENT]?.plugins;
    assert.ok(clientPlugins, "renderer config resolved no client environment");

    const babelPlugin = clientPlugins.find(
      (plugin) => plugin.name === BABEL_PLUGIN_NAME
    );
    assert.ok(
      babelPlugin,
      `${BABEL_PLUGIN_NAME} is missing from the client plugin chain, so React Compiler does not run`
    );

    const output = await transformThrough(
      babelPlugin,
      COMPONENT_FIXTURE_SOURCE,
      COMPONENT_FIXTURE_ID
    );
    assert.match(
      output,
      REACT_19_COMPILER_RUNTIME_IMPORT,
      `${BABEL_PLUGIN_NAME} did not compile the component against React 19's compiler runtime:\n${output}`
    );

    const { filter } = transformHookSchema.parse(babelPlugin.transform);
    const include = idPatterns(filter?.id?.include);
    const exclude = idPatterns(filter?.id?.exclude);
    assert.ok(
      existsSync(RENDERER_ENTRY_ID),
      `${RENDERER_ENTRY_ID} no longer exists, so matching it against the id filter proves nothing`
    );
    assert.ok(
      include.some((pattern) => pattern.test(RENDERER_ENTRY_ID)),
      `no id include pattern admits ${RENDERER_ENTRY_ID}, so the compiler runs over no renderer file`
    );
    assert.ok(
      !exclude.some((pattern) => pattern.test(RENDERER_ENTRY_ID)),
      `an id exclude pattern drops ${RENDERER_ENTRY_ID}, so the compiler never sees it`
    );
    assert.ok(
      exclude.some((pattern) => pattern.test(VENDOR_ID)),
      "the id exclude arm matched no vendor path, so the exclude assertion above cannot fail"
    );
  });

  // ISS-12504 (PR #8914): the doc-sync selection toolbar passes its sections
  // as the Liveblocks Toolbar's component slot so they re-render on every
  // editor transaction. Compiled with a memo cache, the slot returns the same
  // elements forever and the formatting buttons keep their first-render state,
  // so the component opts out with "use no memo".
  test("the doc-sync toolbar's slot component is compiled without a memo cache", async () => {
    const babelPlugin = await clientBabelPlugin();
    assert.ok(
      babelPlugin,
      `${BABEL_PLUGIN_NAME} is missing from the client plugins`
    );
    const output = await transformThrough(
      babelPlugin,
      readFileSync(DOC_SYNC_FLOATING_TOOLBAR_PATH, "utf8"),
      DOC_SYNC_FLOATING_TOOLBAR_PATH
    );
    const compiled = ts.createSourceFile(
      "doc-sync-floating-toolbar.compiled.js",
      output,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const cacheHook = compilerCacheHookName(compiled);
    assert.ok(
      cacheHook,
      "the toolbar module imports no compiler cache hook, so the compiler did not run over it and the check below cannot fail"
    );
    assert.equal(
      functionCallsHook(compiled, "DocSyncFloatingToolbar", cacheHook),
      true,
      "DocSyncFloatingToolbar is not memoized, so the compiler did not run over this module and the check below cannot fail"
    );
    const sectionsMemoized = functionCallsHook(
      compiled,
      "DocSyncToolbarSections",
      cacheHook
    );
    assert.notEqual(
      sectionsMemoized,
      undefined,
      "DocSyncToolbarSections is missing from the compiled toolbar module"
    );
    assert.equal(
      sectionsMemoized,
      false,
      "DocSyncToolbarSections is compiled with a memo cache, so the toolbar's formatting sections never re-render"
    );
  });
});

const DOC_SYNC_FLOATING_TOOLBAR_PATH = path.join(
  desktopDir,
  "../../packages/collaboration/client/doc-sync-floating-toolbar.tsx"
);

const COMPILER_RUNTIME_MODULE = "react/compiler-runtime";

async function clientBabelPlugin(): Promise<Plugin | undefined> {
  const config = await resolveConfig(
    { configFile: RENDERER_CONFIG_PATH },
    "build",
    "production",
    "production"
  );
  return config.environments[CLIENT_ENVIRONMENT]?.plugins.find(
    (candidate) => candidate.name === BABEL_PLUGIN_NAME
  );
}

/** The local name the compiled module binds React's memo cache hook (`c`) to. */
function compilerCacheHookName(source: ts.SourceFile): string | undefined {
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === COMPILER_RUNTIME_MODULE
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        const hook = bindings.elements.find(
          (element) => (element.propertyName ?? element.name).text === "c"
        );
        if (hook) {
          return hook.name.text;
        }
      }
    }
  }
  return undefined;
}

/** Whether the named top-level function calls the hook; undefined when it is absent. */
function functionCallsHook(
  source: ts.SourceFile,
  functionName: string,
  hookName: string
): boolean | undefined {
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName
  );
  if (!declaration) {
    return undefined;
  }
  let calls = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === hookName
    ) {
      calls = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return calls;
}

function idPatterns(value: z.infer<typeof idPatternsSchema>): RegExp[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

async function transformThrough(
  plugin: Plugin,
  code: string,
  id: string
): Promise<string> {
  const hook = plugin.transform;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  if (!handler) {
    throw new Error(`${plugin.name} has no transform hook`);
  }
  // The plugin reads only the environment name (to pick the options it built
  // in `applyToEnvironment` during resolveConfig) and `error` on a Babel failure.
  const context = {
    environment: { name: CLIENT_ENVIRONMENT },
    error(error: unknown): never {
      if (error instanceof Error) {
        throw error;
      }
      const payload = pluginErrorPayloadSchema.safeParse(error);
      const message =
        payload.success && payload.data.message
          ? payload.data.message
          : "Rolldown plugin reported a non-Error failure";
      throw new Error(message, { cause: error });
    },
  };
  const result = await Reflect.apply(handler, context, [
    code,
    id,
    { moduleType: "tsx" },
  ]);
  if (result == null) {
    throw new Error(`${plugin.name} returned no transform result for ${id}`);
  }
  return transformResultSchema.parse(result).code;
}
