/**
 * ISS-5303 — `packaging-workspace-deps.mjs`, the spec-parsing half of Desktop
 * packaging.
 *
 * `stage-packaging-app.mjs` rewrites every `workspace:`/`link:` dependency in
 * the staged `package.json` into something installable from a tarball. To do
 * that it has to answer one deceptively subtle question per dependency: which
 * package does this spec actually install? A `workspace:` range installs the
 * key; an ALIASED `workspace:<name>@<range>` installs a different package under
 * that key. Get it backwards and the stager either packs the wrong member or
 * leaves a `workspace:` spec in a published tarball, where it resolves against
 * a registry that has never heard of `@repo/*` — a packaged app that fails at
 * require time, not at build time.
 *
 * These tests drive all three exports: the runtime-closure SSOT and both spec
 * parsers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, test } from "vitest";
import {
  DESKTOP_RUNTIME_CLOSURE,
  isWorkspaceProtocolSpec,
  resolveWorkspaceDependencyTarget,
} from "../scripts/packaging-workspace-deps.mjs";
import {
  MAIN_VITE_CONFIG,
  WORKSPACE_INLINE_BINDING,
  workspaceInlinePackages,
} from "./helpers/main-vite-workspace-inline.js";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

describe("ISS-5303: the Desktop runtime closure SSOT", () => {
  test("names at least one member, so every consumer loop has something to do", () => {
    // `stage-packaging-app.mjs` builds its packed-member Map from this list. An
    // empty closure would make that Map empty and every downstream membership
    // check vacuously false — the stager would pack nothing and still succeed.
    assert.ok(DESKTOP_RUNTIME_CLOSURE.length > 0);
  });

  test("each entry's packageDir really holds a package of that packageName", () => {
    // The two fields are a claim about the tree: `packageDir` is joined onto
    // `packages/` to find the source to pack, and `packageName` is matched
    // against the staged dependency keys. A rename that moved one without the
    // other would pack the wrong directory, or nothing at all.
    for (const member of DESKTOP_RUNTIME_CLOSURE) {
      const manifestPath = join(
        REPO_ROOT,
        "packages",
        member.packageDir,
        "package.json"
      );
      const manifest: { name?: string } = JSON.parse(
        readFileSync(manifestPath, "utf8")
      );

      assert.equal(
        manifest.name,
        member.packageName,
        `packages/${member.packageDir} does not publish ${member.packageName}`
      );
    }
  });
});

describe("ISS-5303: resolveWorkspaceDependencyTarget", () => {
  test("a link: spec installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/api", "link:../../packages/api"),
      "@repo/api"
    );
  });

  test("a `workspace:*` range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:*"),
      "@repo/lib"
    );
  });

  test("a caret range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:^1.2.3"),
      "@repo/lib"
    );
  });

  test("a tilde range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:~1.2.3"),
      "@repo/lib"
    );
  });

  test("a bare version range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:1.2.3"),
      "@repo/lib"
    );
  });

  test("an empty range installs under the dependency key", () => {
    // `"workspace:"` leaves nothing after the protocol. It must take the
    // plain-range path: falling through to the alias branch would run
    // `lastIndexOf("@")` on `""` and hand the stager an empty package name.
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:"),
      "@repo/lib"
    );
  });

  test("a scoped alias resolves to the aliased target, not the key", () => {
    // The case the whole helper exists for. Returning the key here would send
    // the stager looking for a packed member named `shared`, which does not
    // exist, and the real package would never be packed.
    assert.equal(
      resolveWorkspaceDependencyTarget(
        "shared",
        "workspace:@repo/shared-platform@*"
      ),
      "@repo/shared-platform"
    );
  });

  test("a scoped alias under its own name still resolves to the package name", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget(
        "@repo/shared-platform",
        "workspace:@repo/shared-platform@^1.0.0"
      ),
      "@repo/shared-platform"
    );
  });

  test("an unscoped alias resolves to the aliased target", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("alias", "workspace:real-name@^2.0.0"),
      "real-name"
    );
  });

  test("a scoped alias with no version keeps its leading @", () => {
    // `@repo/thing` has exactly one `@`, at index 0. Slicing at it would yield
    // the empty string, so the helper only treats an `@` past index 0 as the
    // version separator. This is the case that proves that guard is load-bearing.
    assert.equal(
      resolveWorkspaceDependencyTarget("alias", "workspace:@repo/thing"),
      "@repo/thing"
    );
  });
});

describe("ISS-5303: isWorkspaceProtocolSpec", () => {
  test("accepts a workspace: spec", () => {
    assert.equal(isWorkspaceProtocolSpec("workspace:*"), true);
  });

  test("accepts a link: spec", () => {
    assert.equal(isWorkspaceProtocolSpec("link:../../packages/api"), true);
  });

  test("rejects a plain registry range", () => {
    // The consequence of a false positive: the stager would try to rewrite a
    // dependency that pnpm can already fetch from the registry.
    assert.equal(isWorkspaceProtocolSpec("^1.2.3"), false);
  });

  test("rejects a prefix that merely starts with the protocol word", () => {
    assert.equal(isWorkspaceProtocolSpec("workspaces:*"), false);
  });

  test("rejects a non-string spec", () => {
    // package.json is untrusted JSON at this boundary — a dependency value can
    // be any JSON type, and `.startsWith` on a non-string would throw mid-stage.
    assert.equal(isWorkspaceProtocolSpec(undefined), false);
    assert.equal(isWorkspaceProtocolSpec(null), false);
    assert.equal(isWorkspaceProtocolSpec(42), false);
    assert.equal(isWorkspaceProtocolSpec({ spec: "workspace:*" }), false);
  });
});

/**
 * FEA-1859 / ISS-7383 — the session-trace runtime-import contract, restored.
 *
 * FEA-1859 hit a packaged app that failed at require time: desktop main reached
 * for the session-trace derivation helper through `@repo/api`'s BUILT output,
 * which the packaged asar does not carry, because the main build inlines that
 * package from source instead of packing it. Its guard lived in
 * `packaging-workspace-dependencies.test.ts`; FEA-3568 (#3306) deleted that file
 * and moved the helper to `packages/lib`, and `lint-staged.config.js` was then
 * repointed at THIS file (ISS-7403) — which asserts the three packaging exports
 * and nothing about that contract. The contract itself never went away, so per
 * the AGENTS.md Re-homing Guardrail it follows its subject here rather than
 * being dropped with the file that used to hold it.
 *
 * Three assertions, because the contract has three legs and each fails on its
 * own: the helper's package must stay OUT of the packed closure, it must have no
 * built output to reach for, and main must actually import it from source.
 */
describe("FEA-1859/ISS-7383: the session-trace runtime-import contract", () => {
  test("the packages that carry the derivation helper stay out of the packed runtime closure", () => {
    // Read from vite.main.config.ts, which is what actually decides
    // (whitlockk review) — not from a second copy of the list kept here.
    const inlined = workspaceInlinePackages(join(REPO_ROOT, "apps", "desktop"));

    assert.ok(
      inlined.length > 0,
      `no ${WORKSPACE_INLINE_BINDING} array was parsed out of ${MAIN_VITE_CONFIG} — the config was renamed or restructured, and every assertion below would pass over an empty list`
    );

    // The leg that catches a CONFIG-ONLY change: drop @repo/lib from
    // WORKSPACE_INLINE and the main build externalizes it, so packaged main
    // resolves a `.ts`-only, no-`exports` package at runtime and throws.
    assert.ok(
      inlined.includes(DERIVATION_HELPER_PACKAGE),
      `${MAIN_VITE_CONFIG} no longer inlines ${DERIVATION_HELPER_PACKAGE}, which is the package ${SESSION_TRACE_DERIVATION_SPECIFIER} resolves to — it has no build output to externalize to, so packaged main fails at require time`
    );

    for (const packageName of inlined) {
      assert.equal(
        closureDirFor(packageName),
        undefined,
        `${packageName} is bundled from source by the main build, so packing it would ship a second copy whose files the asar's imports never resolve to`
      );
    }

    // The control. Every lookup above returns `undefined` for a name the closure
    // has never heard of too, so without a member that IS packed this passes on
    // an empty closure and states nothing.
    assert.equal(
      closureDirFor(PACKED_CLOSURE_MEMBER),
      "telemetry-contract",
      "the closure no longer packs its one known member, so the assertions above are comparing against nothing"
    );
  });

  test("the derivation helper's package ships no built entry point to reach into", () => {
    const derivationPackage = readManifest("packages/lib/package.json");

    for (const field of BUILT_ENTRY_POINT_FIELDS) {
      assert.ok(
        !(field in derivationPackage),
        `packages/lib declares "${field}", so it now resolves to built output — desktop main imports it from source on the assumption there is none, and the packaging closure excludes it on the same assumption`
      );
    }
    assert.equal(
      derivationPackage.scripts?.build,
      undefined,
      "packages/lib gained a build script; a built artifact is exactly what the packaged app cannot resolve"
    );

    // The control: a workspace member that IS pre-built declares the field this
    // test asserts absent, so the check distinguishes the two kinds of member
    // rather than passing on any manifest at all.
    const packedPackage = readManifest(
      "packages/telemetry-contract/package.json"
    );
    assert.ok(
      "exports" in packedPackage,
      "the pre-built comparison member stopped declaring `exports`, so the absence asserted above no longer distinguishes anything"
    );
  });

  test("desktop main imports the derivation helper from source, with no built-output reach-in", () => {
    const specifiers = importedModuleSpecifiers(
      "src/main/database/session-trace.ts"
    );

    assert.ok(
      specifiers.length > 0,
      "no import was resolved out of session-trace.ts — the parse found nothing, so both assertions below would pass vacuously"
    );
    assert.ok(
      specifiers.includes(SESSION_TRACE_DERIVATION_SPECIFIER),
      `session-trace.ts no longer imports ${SESSION_TRACE_DERIVATION_SPECIFIER}; if the helper moved, this guard and lint-staged.config.js must follow it`
    );
    const reachIns = specifiers.filter((specifier) =>
      specifier.includes(BUILT_OUTPUT_SEGMENT)
    );
    assert.deepEqual(
      reachIns,
      [],
      `session-trace.ts imports ${reachIns.join(", ")} — built output the packaged asar does not carry, which fails at require time in the packaged app and nowhere else`
    );
  });

  test("the derivation helper and its transitive imports actually LOAD", async () => {
    // The leg the deleted guard had and the AST assertion above does not
    // (whitlockk review). Naming a specifier proves the text; only evaluating it
    // proves the module graph resolves. A change inside
    // packages/lib/session-trace/derivation.ts that breaks a source-bundled
    // import path leaves every assertion above green — the specifier string in
    // session-trace.ts never moved — and fails at require time in the packaged
    // app, which is the exact failure FEA-1859 shipped.
    const derivation = await import(SESSION_TRACE_DERIVATION_SPECIFIER);

    // Read the bindings desktop main actually destructures off the AST rather
    // than listing them here, so this cannot drift out of agreement with the
    // importer it is speaking for.
    const required = namedValueImportsFrom(
      "src/main/database/session-trace.ts",
      SESSION_TRACE_DERIVATION_SPECIFIER
    );
    assert.ok(
      required.length > 0,
      `no named import of ${SESSION_TRACE_DERIVATION_SPECIFIER} was resolved out of session-trace.ts — the parse found nothing, so the assertion below would pass vacuously`
    );

    const unresolved = required.filter((name) => !(name in derivation));
    assert.deepEqual(
      unresolved,
      [],
      `${SESSION_TRACE_DERIVATION_SPECIFIER} loaded but exports no ${unresolved.join(", ")} — desktop main destructures those bindings at module scope, so the packaged app throws at require time`
    );

    // The load above cannot see THIS, and the difference matters: a `/dist/`
    // specifier inside the helper resolves fine in a dev tree, because
    // `packages/api/dist` is present locally after any build — and is absent
    // from the packaged asar, so it fails at require time and nowhere else.
    // That is the FEA-1859 crash exactly, one module further down the graph
    // than the assertion on session-trace.ts covers.
    const helperReachIns = importedModuleSpecifiersOf(
      DERIVATION_HELPER_MODULE
    ).filter((specifier) => specifier.includes(BUILT_OUTPUT_SEGMENT));
    assert.deepEqual(
      helperReachIns,
      [],
      `${DERIVATION_HELPER_MODULE} imports ${helperReachIns.join(", ")} — built output the packaged asar does not carry. It resolves here only because a dev tree has those directories built.`
    );
  });
});

/** The package `SESSION_TRACE_DERIVATION_SPECIFIER` resolves to. */
const DERIVATION_HELPER_PACKAGE = "@repo/lib";

/** That specifier's module, repo-relative, for the reach-in scan. */
const DERIVATION_HELPER_MODULE = "packages/lib/session-trace/derivation.ts";

/** The one member that IS packed, so an absence assertion has a control. */
const PACKED_CLOSURE_MEMBER = "@closedloop-ai/telemetry-contract";

/** Manifest fields that would make a workspace member resolve to built output. */
const BUILT_ENTRY_POINT_FIELDS = ["main", "module", "exports", "bin"] as const;

const SESSION_TRACE_DERIVATION_SPECIFIER = "@repo/lib/session-trace/derivation";

/** Any specifier containing this reaches past a package's source entry point. */
const BUILT_OUTPUT_SEGMENT = "/dist/";

function closureDirFor(packageName: string): string | undefined {
  return DESKTOP_RUNTIME_CLOSURE.find(
    (entry: { packageName: string; packageDir: string }) =>
      entry.packageName === packageName
  )?.packageDir;
}

function readManifest(
  repoRelativePath: string
): Record<string, unknown> & { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, repoRelativePath), "utf8"));
}

/**
 * Module specifiers of every static import in one desktop file, read off the
 * parsed AST. The sanctioned mechanism (AGENTS.md → Test Practices): a raw-text
 * scan of a `.ts` file is banned and would be satisfied by a comment.
 */
/**
 * The VALUE bindings one desktop file imports by name from one specifier.
 * Type-only imports are excluded — they are erased before runtime, so a missing
 * one is a typecheck failure rather than the require-time crash this guards.
 */
function namedValueImportsFrom(
  desktopRelativePath: string,
  specifier: string
): string[] {
  const names: string[] = [];
  for (const statement of parseDesktopFile(desktopRelativePath).statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === specifier
      )
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) {
      continue;
    }
    if (!ts.isNamedImports(clause.namedBindings)) {
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) {
        names.push(element.name.text);
      }
    }
  }
  return names;
}

function parseDesktopFile(desktopRelativePath: string): ts.SourceFile {
  return parseRepoFile(join("apps", "desktop", desktopRelativePath));
}

function parseRepoFile(repoRelativePath: string): ts.SourceFile {
  const absolute = join(REPO_ROOT, repoRelativePath);
  return ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

/** {@link importedModuleSpecifiers} for any repo file, not just a desktop one. */
function importedModuleSpecifiersOf(repoRelativePath: string): string[] {
  const specifiers: string[] = [];
  for (const statement of parseRepoFile(repoRelativePath).statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function importedModuleSpecifiers(desktopRelativePath: string): string[] {
  const sourceFile = parseDesktopFile(desktopRelativePath);
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}
