import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getPackagingStageAppDir,
  getPackagingStageRoot,
} from "./packaging-stage-path.mjs";
import {
  DESKTOP_RUNTIME_CLOSURE,
  isWorkspaceProtocolSpec,
  resolveWorkspaceDependencyTarget,
} from "./packaging-workspace-deps.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appDir, "../..");
const stageRoot = getPackagingStageRoot();
const stageAppDir = getPackagingStageAppDir();
const buildOutputDir = path.join(appDir, "dist");
const packageJsonFile = path.join(appDir, "package.json");
const repoNpmrcFile = path.join(repoRoot, ".npmrc");
const stageRootPackageJsonFile = path.join(stageRoot, "package.json");
const stageTarballDir = path.join(stageRoot, "workspace-tarballs");
const stageBuildOutputDir = path.join(stageAppDir, "dist");
const stageNpmrcFile = path.join(stageAppDir, ".npmrc");
const stageWorkspaceYamlFile = path.join(stageAppDir, "pnpm-workspace.yaml");
const TARBALL_SLUG_NON_ALNUM_PATTERN = /[^a-zA-Z0-9]+/g;
const TARBALL_SLUG_EDGE_DASH_PATTERN = /^-+|-+$/g;
const STAGE_WORKSPACE_YAML = `nodeLinker: hoisted
allowBuilds:
  protobufjs: true
`;
// The packaged runtime workspace import closure, keyed by package name with the
// absolute source directory as the value. Built from DESKTOP_RUNTIME_CLOSURE (the
// SSOT in packaging-workspace-deps.mjs), which documents why each package is in
// the closure, why design-system is excluded, and which the post-merge packaging
// validation workflow's path filter is asserted against.
const workspaceDependencyPackages = new Map(
  DESKTOP_RUNTIME_CLOSURE.map(({ packageName, packageDir }) => [
    packageName,
    path.join(repoRoot, "packages", packageDir),
  ])
);

function resolveStageDependencySpec(
  packageJson,
  dependencyName,
  dependency,
  workspaceTarballSpecs
) {
  const workspaceTarballSpec = workspaceTarballSpecs.get(dependencyName);
  if (workspaceTarballSpec) {
    return workspaceTarballSpec;
  }

  if (
    typeof dependency.resolved === "string" &&
    dependency.resolved.length > 0
  ) {
    return dependency.resolved;
  }

  return (
    packageJson.dependencies?.[dependencyName] ??
    packageJson.optionalDependencies?.[dependencyName] ??
    dependency.version
  );
}

async function listTarballs(directory) {
  try {
    return new Set(
      (await readdir(directory)).filter((entry) => entry.endsWith(".tgz"))
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

async function packWorkspaceDependency(dependencyName, packageDir) {
  const before = await listTarballs(stageTarballDir);
  const packResult = spawnSync(
    "pnpm",
    ["--dir", packageDir, "pack", "--pack-destination", stageTarballDir],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  );

  if (packResult.error) {
    throw packResult.error;
  }

  if (packResult.status !== 0) {
    process.stderr.write(packResult.stdout ?? "");
    process.stderr.write(packResult.stderr ?? "");
    process.exit(packResult.status ?? 1);
  }

  const after = await listTarballs(stageTarballDir);
  const created = [...after].filter((entry) => !before.has(entry));
  if (created.length !== 1) {
    throw new Error(
      `Expected pnpm pack for ${dependencyName} to create exactly one tarball.`
    );
  }

  return `file:${path.join(stageTarballDir, created[0])}`;
}

function runTar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      `tar ${args.join(" ")} exited with status ${result.status ?? "unknown"}.`
    );
  }
}

// `pnpm pack` rewrites a package's `workspace:`/`link:` deps into concrete
// registry specs inside its tarball (e.g. @repo/api's deps become
// `@closedloop-ai/loops-api: 0.5.2` and
// `@repo/shared-platform: npm:@closedloop-ai/shared-platform@0.1.0`). pnpm will
// not satisfy those specs from a sibling top-level `file:` dependency, and its
// `overrides` are unreliable for multiple `file:` targets — so left alone they
// escape to npm and 404 (the packages are unpublished). Repoint each such nested
// dependency at its sibling tarball, keeping the original dependency KEY so an
// aliased import (`@repo/shared-platform`) still resolves at runtime. pnpm then
// resolves the whole closure offline into real, hoisted node_modules dirs.
// Members with no workspace-derived deps install from their original tarball.
async function stageWorkspaceMemberTarball(
  memberName,
  originalTarballPath,
  sourceProdDependencies,
  memberOriginalTarballSpecs
) {
  const dependencyRewrites = new Map();
  for (const [dependencyKey, sourceSpec] of Object.entries(
    sourceProdDependencies
  )) {
    if (!isWorkspaceProtocolSpec(sourceSpec)) {
      continue;
    }
    const targetName = resolveWorkspaceDependencyTarget(
      dependencyKey,
      sourceSpec
    );
    const targetTarballSpec = memberOriginalTarballSpecs.get(targetName);
    if (!targetTarballSpec) {
      throw new Error(
        `Workspace member ${memberName} depends on ${targetName} (via "${dependencyKey}": "${sourceSpec}"), which is not a packed closure member. Add it to workspaceDependencyPackages.`
      );
    }
    dependencyRewrites.set(dependencyKey, targetTarballSpec);
  }

  if (dependencyRewrites.size === 0) {
    return originalTarballPath;
  }

  const memberSlug = memberName
    .replace(TARBALL_SLUG_NON_ALNUM_PATTERN, "-")
    .replace(TARBALL_SLUG_EDGE_DASH_PATTERN, "");
  const rewriteDir = path.join(stageTarballDir, `.rewrite-${memberSlug}`);
  await rm(rewriteDir, { recursive: true, force: true });
  await mkdir(rewriteDir, { recursive: true });
  runTar(["-xzf", originalTarballPath, "-C", rewriteDir]);

  const packedManifestPath = path.join(rewriteDir, "package", "package.json");
  const packedManifest = JSON.parse(await readFile(packedManifestPath, "utf8"));
  for (const [dependencyKey, fileSpec] of dependencyRewrites) {
    if (packedManifest.dependencies?.[dependencyKey] === undefined) {
      throw new Error(
        `Expected packed tarball for ${memberName} to declare dependency "${dependencyKey}".`
      );
    }
    packedManifest.dependencies[dependencyKey] = fileSpec;
  }
  await writeFile(
    packedManifestPath,
    `${JSON.stringify(packedManifest, null, 2)}\n`
  );

  const rewrittenTarballPath = path.join(
    stageTarballDir,
    `${memberSlug}-staged.tgz`
  );
  runTar(["-czf", rewrittenTarballPath, "-C", rewriteDir, "package"]);
  await rm(rewriteDir, { recursive: true, force: true });
  return rewrittenTarballPath;
}

function isBundledWorkspaceDependency(packageJson, dependencyName) {
  if (workspaceDependencyPackages.has(dependencyName)) {
    return false;
  }
  const declaredSpec = packageJson.dependencies?.[dependencyName];
  return (
    typeof declaredSpec === "string" &&
    (declaredSpec.startsWith("workspace:") || declaredSpec.startsWith("link:"))
  );
}

function assertNoUnresolvedWorkspaceSpecs(stagePackageJson) {
  for (const [dependencyName, dependencySpec] of Object.entries(
    stagePackageJson.dependencies ?? {}
  )) {
    if (
      typeof dependencySpec === "string" &&
      (dependencySpec.startsWith("workspace:") ||
        dependencySpec.startsWith("link:"))
    ) {
      throw new Error(
        `Staged dependency ${dependencyName} still uses unresolved spec ${dependencySpec}.`
      );
    }
  }
}

function parseJsonFromCommandOutput(output) {
  const trimmedOutput = output.trim();

  try {
    return JSON.parse(trimmedOutput);
  } catch {
    // pnpm may emit warnings before the JSON payload.
  }

  const startIndexCandidates = [
    trimmedOutput.indexOf("["),
    trimmedOutput.indexOf("{"),
  ].filter((index) => index >= 0);

  const startIndex =
    startIndexCandidates.length > 0 ? Math.min(...startIndexCandidates) : 0;

  for (let index = startIndex; index < trimmedOutput.length; index += 1) {
    const candidate = trimmedOutput.slice(startIndex, index + 1);

    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning until the JSON closes.
    }
  }

  throw new Error("Failed to parse pnpm dependency output.");
}

const installedDependencyResult = spawnSync(
  "pnpm",
  ["list", "--prod", "--json", "--depth", "0", "--silent", "--loglevel=error"],
  {
    cwd: appDir,
    encoding: "utf8",
  }
);

if (installedDependencyResult.error) {
  throw installedDependencyResult.error;
}

if (installedDependencyResult.status !== 0) {
  process.stderr.write(installedDependencyResult.stdout ?? "");
  process.stderr.write(installedDependencyResult.stderr ?? "");
  process.exit(installedDependencyResult.status ?? 1);
}

const installedDependencyTree = parseJsonFromCommandOutput(
  installedDependencyResult.stdout ?? ""
);
// `pnpm list` emits one entry per workspace project (the monorepo root first),
// even when invoked from apps/desktop. Select the desktop package by its own
// directory rather than taking [0] — [0] is the repo root, whose dependencies
// are unrelated to the app. Taking [0] silently stages the wrong (tiny) closure
// and ships an app whose runtime imports (electron-updater, electron-log, …)
// are absent from the asar, crashing on launch with ERR_MODULE_NOT_FOUND.
const desktopDependencyProject = Array.isArray(installedDependencyTree)
  ? installedDependencyTree.find((project) => project?.path === appDir)
  : undefined;
const installedDependencies = desktopDependencyProject?.dependencies;

if (
  installedDependencies == null ||
  Object.keys(installedDependencies).length === 0
) {
  throw new Error(
    `No installed production dependencies were found for the desktop package at ${appDir}.`
  );
}

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageAppDir, { recursive: true });
await mkdir(stageTarballDir, { recursive: true });

const packageJson = JSON.parse(await readFile(packageJsonFile, "utf8"));
// Guard against selecting the wrong workspace project. `pnpm list` returns one
// entry per workspace project; picking the wrong one (historically [0], the
// monorepo root) yields a non-empty but wrong dependency set that silently ships
// an app missing its runtime modules. Every declared production dependency must
// appear in the resolved closure.
const declaredProductionDependencyNames = Object.keys(
  packageJson.dependencies ?? {}
);
const unresolvedDeclaredDependencies = declaredProductionDependencyNames.filter(
  (dependencyName) => !(dependencyName in installedDependencies)
);
if (unresolvedDeclaredDependencies.length > 0) {
  throw new Error(
    `Resolved dependency closure is missing declared production dependencies: ${unresolvedDeclaredDependencies.join(", ")}. The wrong workspace project was likely selected from \`pnpm list\`.`
  );
}
const repoNpmrc = await readFile(repoNpmrcFile, "utf8").catch((error) => {
  if (error?.code === "ENOENT") {
    return "";
  }
  throw error;
});
// Pack every closure member and capture its source prod deps. Workspace deps
// left external at runtime are swapped to tarballs at the top level by
// resolveStageDependencySpec. A direct `workspace:*` dep that somehow fails to
// get a tarball is still caught by assertNoUnresolvedWorkspaceSpecs below.
const memberOriginalTarballSpecs = new Map();
const memberSourceProdDependencies = new Map();
for (const [dependencyName, packageDir] of workspaceDependencyPackages) {
  memberOriginalTarballSpecs.set(
    dependencyName,
    await packWorkspaceDependency(dependencyName, packageDir)
  );
  const memberManifest = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8")
  );
  memberSourceProdDependencies.set(
    dependencyName,
    memberManifest.dependencies ?? {}
  );
}
// Resolve the top-level tarball spec for each packed member. Members that depend
// on another workspace package get a rewritten tarball (their nested workspace
// deps repointed at sibling tarballs so the install resolves offline); members
// with only registry deps install from their original tarball unchanged.
const workspaceTarballSpecs = new Map();
for (const [
  dependencyName,
  originalTarballSpec,
] of memberOriginalTarballSpecs) {
  const stagedTarballPath = await stageWorkspaceMemberTarball(
    dependencyName,
    originalTarballSpec.slice("file:".length),
    memberSourceProdDependencies.get(dependencyName),
    memberOriginalTarballSpecs
  );
  workspaceTarballSpecs.set(dependencyName, `file:${stagedTarballPath}`);
}
// Workspace dependencies fall into two buckets. The ones in
// `workspaceDependencyPackages` are packed as tarballs and installed into the
// closure because the main process imports them at runtime as externals. The
// remaining workspace links — @repo/api and @repo/shared-platform (inlined into
// the main/preload bundle by electron-vite), plus @repo/app and design-system
// (bundled into the renderer by Vite) — are not imported from node_modules by
// the packaged app, so they are excluded from the closure. Leaving them in would
// surface their unresolved `workspace:*`/`link:` spec to `pnpm install` and
// abort staging.
const stageDependencyEntries = [];
const excludedWorkspaceDependencies = [];
for (const [dependencyName, dependency] of Object.entries(
  installedDependencies
)) {
  if (isBundledWorkspaceDependency(packageJson, dependencyName)) {
    excludedWorkspaceDependencies.push(dependencyName);
    continue;
  }
  stageDependencyEntries.push([
    dependencyName,
    resolveStageDependencySpec(
      packageJson,
      dependencyName,
      dependency,
      workspaceTarballSpecs
    ),
  ]);
}
if (excludedWorkspaceDependencies.length > 0) {
  process.stdout.write(
    `Excluding bundler-inlined workspace dependencies (main-process or renderer-bundled) from the packaged closure: ${excludedWorkspaceDependencies.join(", ")}\n`
  );
}
const stagePackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  author: packageJson.author,
  private: packageJson.private,
  type: packageJson.type,
  main: packageJson.main,
  dependencies: Object.fromEntries(stageDependencyEntries),
};
const stageRootPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  author: packageJson.author,
  private: packageJson.private,
  type: packageJson.type,
  main: "app/dist/main/index.js",
};
assertNoUnresolvedWorkspaceSpecs(stagePackageJson);

await writeFile(
  path.join(stageAppDir, "package.json"),
  `${JSON.stringify(stagePackageJson, null, 2)}\n`
);
await writeFile(
  stageRootPackageJsonFile,
  `${JSON.stringify(stageRootPackageJson, null, 2)}\n`
);
await writeFile(
  stageNpmrcFile,
  [repoNpmrc.trimEnd(), ""].filter(Boolean).join("\n")
);
// Force a flat, symlink-free node_modules. The packaged main process is ESM
// (`"type": "module"`); ESM bare-specifier resolution does not follow pnpm's
// isolated-layout symlinks (node_modules/<pkg> -> .pnpm/<pkg>@ver/...) once the
// tree is packed into the asar, so an isolated install ships an app that
// crashes on launch with ERR_MODULE_NOT_FOUND for the first such import. The
// hoisted linker places real package directories at node_modules/<pkg>, which
// ESM resolves directly. pnpm 11 reads `node-linker` and `allowBuilds` from
// pnpm-workspace.yaml, not .npmrc, and `--ignore-workspace` would discard that
// file — so the install below intentionally omits it and relies on this
// in-stage workspace root (which also bounds workspace discovery to the stage
// directory).
await writeFile(stageWorkspaceYamlFile, STAGE_WORKSPACE_YAML);

const installResult = spawnSync(
  "pnpm",
  ["install", "--prod", "--prefer-offline", "--no-frozen-lockfile"],
  {
    cwd: stageAppDir,
    stdio: "inherit",
  }
);

if (installResult.error) {
  throw installResult.error;
}

if (installResult.status !== 0) {
  process.exit(installResult.status ?? 1);
}

await stat(buildOutputDir).catch(() => {
  throw new Error(
    "apps/desktop/dist is missing. Run `pnpm build` before staging the packaging app."
  );
});

await cp(buildOutputDir, stageBuildOutputDir, { recursive: true });
