import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  assertLocalAbsolutePathPositiveControls,
  assertNoLocalAbsolutePath,
} from "./privacy-scan";
import { SAMPLE_DIST_PATH } from "./sample-export-constants";

const PACKAGE_PREFIX_PATTERN = /^package\//;
const TYPE_ONLY_RUNTIME_OUTPUTS = new Set([
  "package/dist/schema-shape.js",
  "package/dist/schema-shape.cjs",
]);
const packageRoot = process.cwd();
const smokeRoot = mkdtempSync(join(tmpdir(), "telemetry-contract-content-"));

try {
  assertLocalAbsolutePathPositiveControls();

  const tarballDirectory = join(smokeRoot, "tarball");
  const unpackDirectory = join(smokeRoot, "unpack");
  mkdirSync(tarballDirectory, { recursive: true });
  mkdirSync(unpackDirectory, { recursive: true });

  execFileSync("pnpm", ["pack", "--pack-destination", tarballDirectory], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  const tarballName = readdirSync(tarballDirectory).find((name) =>
    name.endsWith(".tgz")
  );
  if (!tarballName) {
    throw new Error(`No .tgz tarball found in ${tarballDirectory}`);
  }
  const tarballPath = join(tarballDirectory, tarballName);
  const entries = execFileSync("tar", ["-tzf", tarballPath], {
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  let hasDistSample = false;
  for (const entry of entries) {
    assertAllowedEntry(entry);
    const withoutPackagePrefix = entry.replace(PACKAGE_PREFIX_PATTERN, "");
    if (withoutPackagePrefix === SAMPLE_DIST_PATH) {
      hasDistSample = true;
    }
    if (withoutPackagePrefix.startsWith("samples/")) {
      throw new Error(`Source sample leaked into packed package: ${entry}`);
    }
  }
  if (!hasDistSample) {
    throw new Error(
      "Packed package is missing dist sample validate-perf-jsonl.sh"
    );
  }

  execFileSync("tar", ["-xzf", tarballPath, "-C", unpackDirectory], {
    stdio: "inherit",
  });

  const files = execFileSync(
    "find",
    [join(unpackDirectory, "package"), "-type", "f"],
    {
      encoding: "utf-8",
    }
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  for (const file of files) {
    const packedPath = relative(unpackDirectory, file).split("\\").join("/");
    if (
      statSync(file).size === 0 &&
      !TYPE_ONLY_RUNTIME_OUTPUTS.has(packedPath)
    ) {
      throw new Error(`Packed file is empty: ${file}`);
    }
    const source = readFileSync(file, "utf-8");
    for (const forbidden of ["sourceMappingURL", "sourcesContent"]) {
      if (source.includes(forbidden)) {
        throw new Error(`Packed file contains ${forbidden}: ${file}`);
      }
    }
    assertNoLocalAbsolutePath(`Packed file ${file}`, source);
  }
} finally {
  rmSync(smokeRoot, { force: true, recursive: true });
}

function assertAllowedEntry(entry: string) {
  const withoutPackagePrefix = entry.replace(PACKAGE_PREFIX_PATTERN, "");
  const allowed =
    withoutPackagePrefix === "package.json" ||
    withoutPackagePrefix === "README.md" ||
    withoutPackagePrefix === "LICENSE" ||
    withoutPackagePrefix.startsWith("dist/");

  if (!allowed) {
    throw new Error(`Unexpected file in packed package: ${entry}`);
  }

  for (const forbidden of [
    "src/",
    "scripts/",
    "__tests__/",
    ".map",
    ".d.ts.map",
    ".tsbuildinfo",
  ]) {
    if (withoutPackagePrefix.includes(forbidden)) {
      throw new Error(`Forbidden private artifact in packed package: ${entry}`);
    }
  }
}
