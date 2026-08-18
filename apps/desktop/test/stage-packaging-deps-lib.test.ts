/**
 * ISS-5303: the pure dependency-staging logic behind `pnpm stage:packaging`.
 *
 * `scripts/stage-packaging-app.mjs` cannot be imported by a test — it spawns
 * `pnpm list`, `pnpm pack`, `tar` and `pnpm install`, and wipes and rewrites the
 * packaging stage directory, all at module scope. So the logic that decides what
 * ends up in the packaged dependency closure lives in
 * `scripts/stage-packaging-deps-lib.mjs` and is driven directly here.
 *
 * The last block is the wiring guard. `isBundledWorkspaceDependency` used to
 * close over the entrypoint's `workspaceDependencyPackages` Map and now takes the
 * closure's package names as an argument; dropping that argument at the call site
 * still parses and still runs, and would classify every packed closure member as
 * bundler-inlined — silently shipping an app whose runtime imports are absent
 * from the asar. The entrypoint cannot be executed, so that call site is pinned
 * with the sanctioned `ts.createSourceFile` AST check (AGENTS.md → Test
 * Practices) rather than a raw-text scan.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript6";

import { DESKTOP_RUNTIME_CLOSURE } from "../scripts/packaging-workspace-deps.mjs";
import {
  assertNoUnresolvedWorkspaceSpecs,
  isBundledWorkspaceDependency,
  parseJsonFromCommandOutput,
  resolveStageDependencySpec,
  type StagePackageManifest,
} from "../scripts/stage-packaging-deps-lib.mjs";
import {
  declaredFunctionNames,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";
import { forEachNode } from "./helpers/ts-ast.js";

const PACKED_MEMBER = "@closedloop-ai/telemetry-contract";
const PACKED_TARBALL = "file:/tmp/stage/workspace-tarballs/telemetry.tgz";

// The three shapes a workspace dependency can be declared with. A plain range and
// an alias both use the `workspace:` protocol; `link:` is the third. All three are
// unresolvable once the staged manifest leaves the source workspace.
const PLAIN_RANGE_SPEC = "workspace:*";
const ALIASED_SPEC = "workspace:@closedloop-ai/shared-platform@*";
const LINK_SPEC = "link:../shared-platform";

const UNRESOLVED_PLAIN_RANGE_ERROR =
  /Staged dependency @repo\/lib still uses unresolved spec workspace:\*\./;
const UNRESOLVED_ALIAS_ERROR =
  /Staged dependency @repo\/shared-platform still uses unresolved spec workspace:@repo\/shared-platform@\*\./;
const UNRESOLVED_LINK_ERROR =
  /Staged dependency @repo\/shared-platform still uses unresolved spec link:\.\.\/shared-platform\./;
const PARSE_FAILURE_ERROR = /Failed to parse pnpm dependency output\./;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(testDir, "..");

/** The names the extraction moved out of the entrypoint. */
const EXTRACTED_HELPERS = [
  "assertNoUnresolvedWorkspaceSpecs",
  "isBundledWorkspaceDependency",
  "parseJsonFromCommandOutput",
  "resolveStageDependencySpec",
];

function packedNames(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

function noTarballs(): ReadonlyMap<string, string> {
  return new Map();
}

function readDesktopManifest(): StagePackageManifest {
  const manifest: StagePackageManifest = JSON.parse(
    readFileSync(path.join(desktopDir, "package.json"), "utf8")
  );
  return manifest;
}

describe("ISS-5303 resolveStageDependencySpec", () => {
  test("a packed closure member stages as its tarball, outranking resolved and the declared range", () => {
    // The whole point of packing: the staged manifest must point at the local
    // `.tgz`, never at the registry URL pnpm resolved from the source workspace
    // (these packages are unpublished, so that URL 404s during staging).
    const spec = resolveStageDependencySpec(
      { dependencies: { [PACKED_MEMBER]: PLAIN_RANGE_SPEC } },
      PACKED_MEMBER,
      {
        version: "0.1.0",
        resolved: "https://registry.npmjs.org/telemetry/-/telemetry-0.1.0.tgz",
      },
      new Map([[PACKED_MEMBER, PACKED_TARBALL]])
    );

    assert.equal(spec, PACKED_TARBALL);
  });

  test("an unpacked dependency stages as the concrete URL pnpm resolved", () => {
    const resolved =
      "https://registry.npmjs.org/electron-log/-/electron-log-5.4.3.tgz";

    const spec = resolveStageDependencySpec(
      { dependencies: { "electron-log": "^5.4.3" } },
      "electron-log",
      { version: "5.4.3", resolved },
      noTarballs()
    );

    assert.equal(spec, resolved);
  });

  test("an empty resolved string falls through to the declared range", () => {
    // `pnpm list` reports `resolved: ""` for some entries. Staging that empty
    // string would write `"electron-log": ""` into the manifest, which pnpm
    // installs as `latest` — a silent, unpinned upgrade at package time.
    const spec = resolveStageDependencySpec(
      { dependencies: { "electron-log": "^5.4.3" } },
      "electron-log",
      { version: "5.4.3", resolved: "" },
      noTarballs()
    );

    assert.equal(spec, "^5.4.3");
  });

  test("an optional dependency stages as its optionalDependencies range", () => {
    const spec = resolveStageDependencySpec(
      { optionalDependencies: { fsevents: "^2.3.3" } },
      "fsevents",
      { version: "2.3.3" },
      noTarballs()
    );

    assert.equal(spec, "^2.3.3");
  });

  test("a transitively installed dependency the manifest never declares stages as its installed version", () => {
    const spec = resolveStageDependencySpec(
      { dependencies: { "electron-log": "^5.4.3" } },
      "busboy",
      { version: "1.6.0" },
      noTarballs()
    );

    assert.equal(spec, "1.6.0");
  });

  test("an unpacked workspace dependency leaks its spec verbatim — plain range, alias and link alike", () => {
    // Nothing in this resolver rewrites a `workspace:`/`link:` spec; a member that
    // failed to get a tarball carries its unresolvable spec straight into the
    // staged manifest. That leak is exactly what the guard below exists to stop,
    // so pin it for all three declaration shapes rather than assuming one.
    const declared = {
      "@repo/lib": PLAIN_RANGE_SPEC,
      "@repo/shared-platform": ALIASED_SPEC,
      "@repo/crewd": LINK_SPEC,
    };

    for (const [dependencyName, declaredSpec] of Object.entries(declared)) {
      assert.equal(
        resolveStageDependencySpec(
          { dependencies: declared },
          dependencyName,
          { version: "0.0.0" },
          noTarballs()
        ),
        declaredSpec
      );
    }
  });
});

describe("ISS-5303 isBundledWorkspaceDependency", () => {
  test("a packed closure member is external, not bundled", () => {
    // It is imported from node_modules at runtime, so it must survive into the
    // staged manifest even though it is declared with a workspace spec.
    assert.equal(
      isBundledWorkspaceDependency(
        { dependencies: { [PACKED_MEMBER]: PLAIN_RANGE_SPEC } },
        PACKED_MEMBER,
        packedNames(PACKED_MEMBER)
      ),
      false
    );
  });

  test("an unpacked workspace:* plain-range dependency is bundled", () => {
    assert.equal(
      isBundledWorkspaceDependency(
        { dependencies: { "@repo/lib": PLAIN_RANGE_SPEC } },
        "@repo/lib",
        packedNames(PACKED_MEMBER)
      ),
      true
    );
  });

  test("an unpacked aliased workspace:<name>@<range> dependency is bundled", () => {
    assert.equal(
      isBundledWorkspaceDependency(
        { dependencies: { "@repo/shared-platform": ALIASED_SPEC } },
        "@repo/shared-platform",
        packedNames(PACKED_MEMBER)
      ),
      true
    );
  });

  test("an unpacked link: dependency is bundled", () => {
    assert.equal(
      isBundledWorkspaceDependency(
        { dependencies: { "@repo/shared-platform": LINK_SPEC } },
        "@repo/shared-platform",
        packedNames(PACKED_MEMBER)
      ),
      true
    );
  });

  test("a registry dependency is never bundled", () => {
    assert.equal(
      isBundledWorkspaceDependency(
        { dependencies: { "electron-log": "^5.4.3" } },
        "electron-log",
        packedNames(PACKED_MEMBER)
      ),
      false
    );
  });

  test("a dependency the manifest does not declare is not bundled", () => {
    // Transitive installs show up in the `pnpm list` closure without a manifest
    // entry. Dropping them would strip the packaged app's real dependency tree.
    assert.equal(
      isBundledWorkspaceDependency(
        { dependencies: { "electron-log": "^5.4.3" } },
        "busboy",
        packedNames(PACKED_MEMBER)
      ),
      false
    );
  });

  test("membership is read from the set the caller passes, not from module state", () => {
    // The extraction's contract: the same manifest and the same dependency name
    // classify differently purely on the closure handed in. Before ISS-5303 this
    // was a module-level Map, so the classifier could not be driven at all.
    const manifest = { dependencies: { "@repo/lib": PLAIN_RANGE_SPEC } };

    assert.equal(
      isBundledWorkspaceDependency(manifest, "@repo/lib", packedNames()),
      true
    );
    assert.equal(
      isBundledWorkspaceDependency(
        manifest,
        "@repo/lib",
        packedNames("@repo/lib")
      ),
      false
    );
  });

  test("against the real manifest, every workspace dependency is bundled except the packed closure", () => {
    // Grounds the synthetic cases in the shipped data: apps/desktop declares a
    // handful of workspace dependencies, and exactly the DESKTOP_RUNTIME_CLOSURE
    // members may survive into the staged manifest. A closure derived from the
    // wrong source (or an empty one) fails here rather than at package time.
    // Phrased as an invariant, not a fixed list, so adding a bundler-inlined
    // workspace package does not redden it.
    const manifest = readDesktopManifest();
    const closureNames = new Set(
      DESKTOP_RUNTIME_CLOSURE.map((member) => member.packageName)
    );
    assert.ok(closureNames.size > 0, "the runtime closure must not be empty");

    const bundled: string[] = [];
    const external: string[] = [];
    for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
      const target = isBundledWorkspaceDependency(
        manifest,
        dependencyName,
        closureNames
      )
        ? bundled
        : external;
      target.push(dependencyName);
    }

    for (const packedName of closureNames) {
      assert.ok(
        external.includes(packedName),
        `${packedName} is packed into the closure but was classified as bundler-inlined`
      );
    }
    assert.ok(
      bundled.includes("@repo/api"),
      "@repo/api is inlined from source by electron-vite and must be dropped from the staged closure"
    );
    assert.ok(
      external.includes("electron-updater"),
      "a registry dependency must never be dropped from the staged closure"
    );
  });
});

describe("ISS-5303 assertNoUnresolvedWorkspaceSpecs", () => {
  test("rejects a staged manifest that kept a workspace:* plain-range spec", () => {
    // The packaging safety guard. `pnpm install` cannot resolve a workspace spec
    // outside the source workspace, so a leak here has to abort staging loudly
    // instead of producing a half-installed asar.
    assert.throws(
      () =>
        assertNoUnresolvedWorkspaceSpecs({
          dependencies: {
            "electron-log": "^5.4.3",
            "@repo/lib": PLAIN_RANGE_SPEC,
          },
        }),
      UNRESOLVED_PLAIN_RANGE_ERROR
    );
  });

  test("rejects a staged manifest that kept an aliased workspace:<name>@<range> spec", () => {
    assert.throws(
      () =>
        assertNoUnresolvedWorkspaceSpecs({
          dependencies: { "@repo/shared-platform": ALIASED_SPEC },
        }),
      UNRESOLVED_ALIAS_ERROR
    );
  });

  test("rejects a staged manifest that kept a link: spec", () => {
    assert.throws(
      () =>
        assertNoUnresolvedWorkspaceSpecs({
          dependencies: { "@repo/shared-platform": LINK_SPEC },
        }),
      UNRESOLVED_LINK_ERROR
    );
  });

  test("accepts a manifest of file: tarballs and registry ranges", () => {
    assert.doesNotThrow(() =>
      assertNoUnresolvedWorkspaceSpecs({
        dependencies: {
          [PACKED_MEMBER]: PACKED_TARBALL,
          "electron-log": "^5.4.3",
          zod: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
        },
      })
    );
  });

  test("accepts a manifest with no dependencies at all", () => {
    assert.doesNotThrow(() => assertNoUnresolvedWorkspaceSpecs({}));
  });
});

describe("ISS-5303 parseJsonFromCommandOutput", () => {
  test("parses clean JSON output", () => {
    assert.deepEqual(
      parseJsonFromCommandOutput('[{"path":"/repo/apps/desktop"}]'),
      [{ path: "/repo/apps/desktop" }]
    );
  });

  test("parses output padded with surrounding whitespace", () => {
    assert.deepEqual(parseJsonFromCommandOutput('\n  {"name":"desktop"}  \n'), {
      name: "desktop",
    });
  });

  test("skips the warning lines pnpm emits before the payload", () => {
    // The reason this helper exists: `pnpm list --json` prefixes its payload with
    // deprecation and peer-dependency warnings on stdout, so a bare JSON.parse of
    // the command output throws.
    const output = [
      " WARN  deprecated request@2.88.2",
      " WARN  Issues with peer dependencies found",
      '[{"path":"/repo/apps/desktop","dependencies":{}}]',
    ].join("\n");

    assert.deepEqual(parseJsonFromCommandOutput(output), [
      { path: "/repo/apps/desktop", dependencies: {} },
    ]);
  });

  test("stops at the end of the payload and ignores trailing noise", () => {
    assert.deepEqual(
      parseJsonFromCommandOutput("WARN peers\n[1,2,3]\nDone in 1.2s"),
      [1, 2, 3]
    );
  });

  test("throws when the output carries no JSON at all", () => {
    assert.throws(
      () => parseJsonFromCommandOutput("ERR_PNPM_NO_MATCHING_VERSION\n"),
      PARSE_FAILURE_ERROR
    );
  });

  test("throws on a truncated payload rather than returning a partial tree", () => {
    // A killed `pnpm list` can flush half its stdout. Returning the prefix that
    // happens to parse would stage a silently truncated dependency closure.
    assert.throws(
      () => parseJsonFromCommandOutput('[{"path":"/repo/apps/desktop"'),
      PARSE_FAILURE_ERROR
    );
  });

  test("throws on empty output", () => {
    assert.throws(() => parseJsonFromCommandOutput("   "), PARSE_FAILURE_ERROR);
  });
});

const entrypoint = parseDesktopScript("stage-packaging-app.mjs");

/**
 * Every `name(...)` call in the entrypoint. The shared `calledIdentifiers`
 * helper answers "is it called at all"; this one keeps the nodes because the
 * argument LIST is what the parameterization turns on.
 */
function callsTo(functionName: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  forEachNode(entrypoint, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName
    ) {
      calls.push(node);
    }
  });
  return calls;
}

/** Identifiers appearing anywhere in `const <variableName> = …`. */
function initializerIdentifiers(variableName: string): string[] {
  const initializers: ts.Expression[] = [];
  forEachNode(entrypoint, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      initializers.push(node.initializer);
    }
  });
  if (initializers.length !== 1) {
    throw new Error(
      `expected exactly one ${variableName} declaration in stage-packaging-app.mjs, found ${initializers.length}`
    );
  }

  const names: string[] = [];
  forEachNode(initializers[0], (node) => {
    if (ts.isIdentifier(node)) {
      names.push(node.text);
    }
  });
  return names;
}

function identifierText(node: ts.Expression): string | null {
  return ts.isIdentifier(node) ? node.text : null;
}

describe("ISS-5303 stage-packaging-app.mjs wiring", () => {
  test("takes all four staged-dependency helpers from the extracted lib", () => {
    assert.deepEqual(
      namedImportsFrom(entrypoint, "./stage-packaging-deps-lib.mjs"),
      EXTRACTED_HELPERS
    );
  });

  test("keeps no local copy of an extracted helper", () => {
    // A re-added `function isBundledWorkspaceDependency(…)` shadows the import,
    // so every behavior test above would be exercising dead code while the
    // entrypoint quietly ran an untested second implementation.
    const shadowed = declaredFunctionNames(entrypoint).filter((name) =>
      EXTRACTED_HELPERS.includes(name)
    );

    assert.deepEqual(shadowed, []);
  });

  test("passes the packed closure name set into isBundledWorkspaceDependency", () => {
    const calls = callsTo("isBundledWorkspaceDependency");
    assert.equal(calls.length, 1, "expected exactly one classification site");

    assert.equal(
      calls[0].arguments.length,
      3,
      "the classifier reads closure membership from its third argument; dropping it classifies every packed member as bundler-inlined and ships an asar missing its runtime imports"
    );
    assert.equal(
      identifierText(calls[0].arguments[2]),
      "packedWorkspacePackageNames"
    );
  });

  test("derives that set from the DESKTOP_RUNTIME_CLOSURE SSOT, not a second literal", () => {
    assert.ok(
      initializerIdentifiers("packedWorkspacePackageNames").includes(
        "workspaceDependencyPackages"
      ),
      "packedWorkspacePackageNames must be derived from the packed-member Map"
    );
    assert.ok(
      initializerIdentifiers("workspaceDependencyPackages").includes(
        "DESKTOP_RUNTIME_CLOSURE"
      ),
      "the packed-member Map must be derived from DESKTOP_RUNTIME_CLOSURE"
    );
    assert.ok(
      namedImportsFrom(entrypoint, "./packaging-workspace-deps.mjs").includes(
        "DESKTOP_RUNTIME_CLOSURE"
      ),
      "DESKTOP_RUNTIME_CLOSURE must come from the SSOT module"
    );
  });
});
