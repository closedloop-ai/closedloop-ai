// @ts-check
/**
 * Generates the desktop-local Prisma client only when its inputs changed.
 *
 * The generated client is ignored output under src/main/database/generated.
 * A fingerprint keeps repeated dev launches from paying `prisma generate`
 * when schema/config/dependency inputs are identical.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");
const repoRoot = path.join(appDir, "..", "..");
const generatedDir = path.join(appDir, "src", "main", "database", "generated");
const fingerprintFile = path.join(generatedDir, ".prisma-generate-fingerprint");

const requiredOutputs = [
  "client.ts",
  "browser.ts",
  path.join("internal", "class.ts"),
  path.join("internal", "prismaNamespace.ts"),
];

const fingerprint = inputFingerprint([
  path.join(appDir, "prisma", "schema.prisma"),
  path.join(appDir, "prisma.config.ts"),
  path.join(appDir, "package.json"),
  path.join(repoRoot, "pnpm-lock.yaml"),
]);

if (isGeneratedClientFresh(fingerprint)) {
  process.stdout.write("prisma-generate: unchanged\n");
  process.exit(0);
}

const result = spawnSync("pnpm", ["exec", "prisma", "generate"], {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

mkdirSync(generatedDir, { recursive: true });
writeFileSync(fingerprintFile, `${fingerprint}\n`, "utf8");

function isGeneratedClientFresh(fingerprintValue) {
  if (!existsSync(fingerprintFile)) {
    return false;
  }

  if (readFileSync(fingerprintFile, "utf8").trim() !== fingerprintValue) {
    return false;
  }

  return requiredOutputs.every((relativePath) =>
    existsSync(path.join(generatedDir, relativePath))
  );
}

function inputFingerprint(filePaths) {
  const hash = createHash("sha256");

  for (const filePath of filePaths) {
    hash.update(path.relative(repoRoot, filePath));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}
