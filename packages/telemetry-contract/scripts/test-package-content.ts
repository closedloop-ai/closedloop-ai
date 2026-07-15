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
import {
  SAMPLE_DIST_PATH,
  SAMPLE_EXPORT_PATH,
  SAMPLE_EXPORT_TARGET,
} from "./sample-export-constants";

const PACKAGE_PREFIX_PATTERN = /^package\//;
const RELATIVE_PATH_PREFIX_PATTERN = /^\.\//;
const TYPE_ONLY_RUNTIME_OUTPUTS = new Set([
  "package/dist/schema-shape.js",
  "package/dist/schema-shape.cjs",
]);
const SCHEMA_EXPORT_PATH_PREFIX = "./schemas/";
const SCHEMA_EXPORT_TARGET_PREFIX = "./dist/schemas/";
const PACKED_ARTIFACT_EXPORTS = [
  {
    exportPath: SAMPLE_EXPORT_PATH,
    packedPath: SAMPLE_DIST_PATH,
    target: SAMPLE_EXPORT_TARGET,
  },
] as const;
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

  for (const entry of entries) {
    assertAllowedEntry(entry);
    const withoutPackagePrefix = entry.replace(PACKAGE_PREFIX_PATTERN, "");
    if (withoutPackagePrefix.startsWith("samples/")) {
      throw new Error(`Source sample leaked into packed package: ${entry}`);
    }
  }
  assertPackedArtifactExports(entries);

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

function assertPackedArtifactExports(entries: string[]) {
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf-8")
  );
  const packedEntries = new Set(entries);
  const missingTargets: string[] = [];

  for (const [exportPath, exportValue] of Object.entries(packageJson.exports)) {
    if (!exportPath.startsWith(SCHEMA_EXPORT_PATH_PREFIX)) {
      continue;
    }
    if (
      typeof exportValue !== "object" ||
      exportValue === null ||
      !("default" in exportValue) ||
      typeof exportValue.default !== "string" ||
      !exportValue.default.startsWith(SCHEMA_EXPORT_TARGET_PREFIX)
    ) {
      throw new Error(`Schema export has invalid target: ${exportPath}`);
    }

    const packedTarget = `package/${exportValue.default.replace(
      RELATIVE_PATH_PREFIX_PATTERN,
      ""
    )}`;
    if (!packedEntries.has(packedTarget)) {
      missingTargets.push(packedTarget);
    }
  }

  for (const artifactExport of PACKED_ARTIFACT_EXPORTS) {
    const exportValue = packageJson.exports[artifactExport.exportPath];
    if (
      typeof exportValue !== "object" ||
      exportValue === null ||
      !("default" in exportValue) ||
      typeof exportValue.default !== "string" ||
      exportValue.default !== artifactExport.target
    ) {
      throw new Error(
        `Packed artifact export has invalid target: ${artifactExport.exportPath}`
      );
    }

    const packedTarget = `package/${artifactExport.packedPath.replace(
      RELATIVE_PATH_PREFIX_PATTERN,
      ""
    )}`;
    if (!packedEntries.has(packedTarget)) {
      missingTargets.push(packedTarget);
    }
  }

  if (missingTargets.length > 0) {
    throw new Error(
      `Packed package is missing export targets: ${missingTargets.join(", ")}`
    );
  }
}
