import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

const exactVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const packageKeyPattern = /^(@[^/]+\/[^@]+|[^@]+)@/;
const patchHashPattern = /\(patch_hash=[^)]+\)/g;
const reference = z.union([z.string(), z.object({ version: z.string() })]);
const references = z.record(z.string(), reference);
const edges = z.object({
  dependencies: references.optional(),
  optionalDependencies: references.optional(),
});
const lockSchema = z.object({
  importers: z.record(z.string(), edges),
  packages: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      version: z.string().optional(),
      resolution: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  snapshots: z.record(z.string(), edges),
  patchedDependencies: z
    .record(z.string(), z.union([z.string(), z.object({ hash: z.string() })]))
    .optional(),
});
const workspaceSchema = z.object({
  patchedDependencies: z.record(z.string(), z.string()).optional(),
});
const stageSchema = z
  .object({
    nodeLinker: z.string(),
    allowBuilds: z.record(z.string(), z.boolean()),
    patchedDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

/** Resolve applicable canonical exact-version patches from the staged production graph. */
export function selectStagedRuntimePatches(workspace, lockfile) {
  const registrations =
    workspaceSchema.parse(workspace).patchedDependencies ?? {};
  const graph = runtimeGraph(lockSchema.parse(lockfile));
  const patches = [];
  for (const [selector, patchPath] of Object.entries(registrations)) {
    const match = selector.match(packageKeyPattern);
    const name = match?.[1];
    const version = name ? selector.slice(name.length + 1) : "";
    if (!(name && exactVersionPattern.test(version))) {
      throw new Error(
        `Unsupported canonical patch selector ${selector}; staging requires exact name@version registrations.`
      );
    }
    if (
      graph.packages.some((pkg) => pkg.name === name && pkg.version === version)
    ) {
      patches.push({ selector, path: patchPath });
    }
  }
  return { graph, patches };
}

/** Copy selected source patch bytes and configure the independent staging workspace. */
export async function prepareStagedRuntimePatches(repoRoot, stageAppDir) {
  const workspace = parse(
    await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")
  );
  const lockfile = parse(
    await readFile(path.join(stageAppDir, "pnpm-lock.yaml"), "utf8")
  );
  const selection = selectStagedRuntimePatches(workspace, lockfile);
  const configFile = path.join(stageAppDir, "pnpm-workspace.yaml");
  const config = stageSchema.parse(parse(await readFile(configFile, "utf8")));
  if (config.patchedDependencies) {
    throw new Error("Staging patch preparation requires a fresh workspace.");
  }
  const patches = [];
  for (const patch of selection.patches) {
    const source = await safeSourcePath(repoRoot, patch.path);
    const target = safeRelativePath(stageAppDir, patch.path);
    const bytes = await readFile(source);
    await createSafeTargetDirectory(stageAppDir, path.dirname(target));
    const hash = digest(bytes);
    await copySafeAsset(stageAppDir, source, target, hash);
    if (digest(await readFile(target)) !== hash) {
      throw new Error(`Staged patch bytes differ for ${patch.selector}.`);
    }
    patches.push({ ...patch, hash });
  }
  if (patches.length > 0) {
    config.patchedDependencies = Object.fromEntries(
      patches.map((patch) => [patch.selector, patch.path])
    );
  }
  await writeFile(configFile, stringify(config));
  return { graph: selection.graph, patches };
}

/** Refuse changed resolution or unapplied/mutated patches after the ordinary install. */
export async function verifyStagedRuntimePatches(stageAppDir, prepared) {
  const finalLock = lockSchema.parse(
    parse(await readFile(path.join(stageAppDir, "pnpm-lock.yaml"), "utf8"))
  );
  const graph = runtimeGraph(finalLock);
  if (graph.signature !== prepared.graph.signature) {
    throw new Error(
      "Staged production dependency resolution changed while applying runtime patches."
    );
  }
  const config = stageSchema.parse(
    parse(await readFile(path.join(stageAppDir, "pnpm-workspace.yaml"), "utf8"))
  );
  const expected = Object.fromEntries(
    prepared.patches.map((patch) => [patch.selector, patch.path])
  );
  if (
    JSON.stringify(config.patchedDependencies ?? {}) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "Staged canonical patch registrations changed during install."
    );
  }
  for (const patch of prepared.patches) {
    const entry = finalLock.patchedDependencies?.[patch.selector];
    const hash = typeof entry === "string" ? entry : entry?.hash;
    if (hash !== patch.hash) {
      throw new Error(
        `Runtime patch ${patch.selector} was not registered with its source hash.`
      );
    }
    if (
      digest(await readFile(safeRelativePath(stageAppDir, patch.path))) !==
      patch.hash
    ) {
      throw new Error(
        `Runtime patch asset ${patch.selector} changed during install.`
      );
    }
    const selected = graph.packages.filter(
      (pkg) => `${pkg.name}@${pkg.version}` === patch.selector
    );
    if (
      selected.length === 0 ||
      selected.some(
        (pkg) => !hasOwnPatchHash(finalLock.packages, pkg.snapshot, patch.hash)
      )
    ) {
      throw new Error(
        `Runtime patch ${patch.selector} is missing from the installed dependency graph.`
      );
    }
  }
}

/** Follow only importer-root production/optional edges, retaining peer-context identities. */
function runtimeGraph(lock) {
  const importer = lock.importers["."];
  if (!importer) {
    throw new Error("Staged lockfile has no root importer.");
  }
  const queue = edgeEntries(importer);
  const rootEdges = queue.map((edge) => normalizeEdge(edge));
  const visited = new Set();
  const packages = [];
  const nodes = [];
  while (queue.length > 0) {
    const edge = queue.pop();
    const snapshot = resolveSnapshot(lock, edge);
    if (visited.has(snapshot)) {
      continue;
    }
    visited.add(snapshot);
    const key = packageKey(lock.packages, snapshot);
    const metadata = lock.packages[key];
    const name = metadata.name ?? key.match(packageKeyPattern)?.[1];
    const version =
      metadata.version ?? (name ? key.slice(name.length + 1) : "");
    if (!(name && exactVersionPattern.test(version))) {
      throw new Error(
        `Staged package ${key} has no exact resolved name/version.`
      );
    }
    const children = edgeEntries(lock.snapshots[snapshot]);
    packages.push({ name, version, snapshot });
    nodes.push({
      id: normalize(snapshot),
      name,
      version,
      resolution: metadata.resolution ?? null,
      edges: children.map(normalizeEdge).sort(compareJson),
    });
    queue.push(...children);
  }
  nodes.sort(compareJson);
  rootEdges.sort(compareJson);
  return { packages, signature: JSON.stringify({ rootEdges, nodes }) };
}

function edgeEntries(node) {
  return ["dependencies", "optionalDependencies"].flatMap((kind) =>
    Object.entries(node[kind] ?? {}).map(([name, ref]) => ({
      kind,
      name,
      ref: typeof ref === "string" ? ref : ref.version,
    }))
  );
}

function resolveSnapshot(lock, edge) {
  for (const candidate of [`${edge.name}@${edge.ref}`, edge.ref]) {
    if (Object.hasOwn(lock.snapshots, candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Unresolved staged production dependency ${edge.name}@${edge.ref}.`
  );
}

function packageKey(packages, snapshot) {
  let candidate = snapshot;
  while (!Object.hasOwn(packages, candidate)) {
    const shortened = stripLastSuffix(candidate);
    if (shortened === candidate) {
      throw new Error(`Missing resolved package metadata for ${snapshot}.`);
    }
    candidate = shortened;
  }
  return candidate;
}

function stripLastSuffix(value) {
  if (!value.endsWith(")")) {
    return value;
  }
  let depth = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] === ")") {
      depth += 1;
    }
    if (value[index] === "(") {
      depth -= 1;
    }
    if (depth === 0) {
      return value.slice(0, index);
    }
  }
  return value;
}

function normalize(value) {
  return value.replace(patchHashPattern, "");
}
function normalizeEdge(edge) {
  return { ...edge, ref: normalize(edge.ref) };
}
function compareJson(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(root, relative) {
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`Patch path must be repository-relative: ${relative}.`);
  }
  const resolved = path.resolve(root, relative);
  const inside = path.relative(root, resolved);
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    throw new Error(`Patch path escapes its root: ${relative}.`);
  }
  return resolved;
}

async function safeSourcePath(root, relative) {
  const source = safeRelativePath(root, relative);
  const actualRoot = await realpath(root);
  const actual = await realpath(source);
  safeRelativePath(actualRoot, path.relative(actualRoot, actual));
  if (!(await stat(actual)).isFile()) {
    throw new Error(`Patch asset must be a regular file: ${relative}.`);
  }
  return actual;
}

async function copySafeAsset(root, source, target, hash) {
  const actualRoot = await realpath(root);
  const parent = await realpath(path.dirname(target));
  if (parent !== actualRoot) {
    safeRelativePath(actualRoot, path.relative(actualRoot, parent));
  }
  const existing = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || digest(await readFile(target)) !== hash) {
      throw new Error(
        "Staged patch asset collides with different bytes or a non-regular file."
      );
    }
    return;
  }
  await copyFile(source, target);
}

async function createSafeTargetDirectory(root, directory) {
  let current = root;
  const relative = path.relative(root, directory);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const existing = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (existing) {
      if (!existing.isDirectory()) {
        throw new Error(
          "Staged patch parent must be a real directory, not a symlink."
        );
      }
    } else {
      await mkdir(current);
    }
  }
}

function hasOwnPatchHash(packages, snapshot, hash) {
  let suffix = snapshot.slice(packageKey(packages, snapshot).length);
  while (suffix) {
    const prefix = stripLastSuffix(suffix);
    if (prefix === suffix) {
      return false;
    }
    if (suffix.slice(prefix.length) === `(patch_hash=${hash})`) {
      return true;
    }
    suffix = prefix;
  }
  return false;
}
