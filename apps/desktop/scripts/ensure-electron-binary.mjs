#!/usr/bin/env node
/**
 * Verifies Electron's platform binary and repairs the install when GitHub
 * Actions leaves the npm package present but without a usable dist/path.txt.
 *
 * The repair path intentionally avoids @electron/get because that helper was
 * unreliable on the Node 24 Ubuntu runner during FEA-1543 CI remediation.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const appRequire = createRequire(import.meta.url);
const electronPackageJsonPath = appRequire.resolve("electron/package.json");
const electronDir = path.dirname(electronPackageJsonPath);
const electronRequire = createRequire(path.join(electronDir, "install.js"));
const electronIndexPath = appRequire.resolve("electron");
const electronPackage = JSON.parse(
  readFileSync(electronPackageJsonPath, "utf8")
);

function getPlatformPath(platform) {
  const platformPaths = {
    darwin: "Electron.app/Contents/MacOS/Electron",
    freebsd: "electron",
    linux: "electron",
    mas: "Electron.app/Contents/MacOS/Electron",
    openbsd: "electron",
    win32: "electron.exe",
  };
  const platformPath = platformPaths[platform];
  if (platformPath == null) {
    throw new Error(
      `Electron builds are not available on platform: ${platform}`
    );
  }
  return platformPath;
}

function getArch(platform) {
  if (process.env.npm_config_arch) {
    return process.env.npm_config_arch;
  }
  if (
    platform !== "darwin" ||
    process.platform !== "darwin" ||
    process.arch !== "x64"
  ) {
    return process.arch;
  }

  const translated = spawnSync("sysctl", ["-in", "sysctl.proc_translated"], {
    encoding: "utf8",
  });
  return translated.status === 0 && translated.stdout.trim() === "1"
    ? "arm64"
    : process.arch;
}

function verifyInstalledBinary() {
  delete appRequire.cache[electronIndexPath];
  const electronBinary = appRequire("electron");
  if (typeof electronBinary !== "string" || electronBinary.length === 0) {
    throw new Error("Electron module did not resolve to a binary path.");
  }
  if (!existsSync(electronBinary)) {
    throw new Error(`Electron binary is missing at ${electronBinary}`);
  }
  const binaryStats = statSync(electronBinary);
  if (!binaryStats.isFile() || binaryStats.size === 0) {
    throw new Error(
      `Electron binary is not a non-empty file at ${electronBinary}`
    );
  }
  return electronBinary;
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}`
    );
  }
}

function repairElectronBinary() {
  const version = electronPackage.version;
  const platform = process.env.npm_config_platform || process.platform;
  const arch = getArch(platform);
  const platformPath = getPlatformPath(platform);
  const artifact = `electron-v${version}-${platform}-${arch}.zip`;
  const checksums = electronRequire("./checksums.json");
  const expectedChecksum = checksums[artifact];
  if (expectedChecksum == null) {
    throw new Error(`Missing Electron checksum for ${artifact}`);
  }

  const downloadDir =
    process.env.RUNNER_TEMP || path.join(tmpdir(), "closedloop-desktop-binary");
  mkdirSync(downloadDir, { recursive: true });
  const zipPath = path.join(downloadDir, artifact);
  const downloadUrl = `https://github.com/electron/electron/releases/download/v${version}/${artifact}`;

  console.log(`Downloading ${artifact}`);
  runChecked("curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--output",
    zipPath,
    downloadUrl,
  ]);

  const actualChecksum = createHash("sha256")
    .update(readFileSync(zipPath))
    .digest("hex");
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Electron checksum mismatch for ${artifact}: expected ${expectedChecksum}, got ${actualChecksum}`
    );
  }

  const distDir = path.join(electronDir, "dist");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  runChecked("unzip", ["-q", zipPath, "-d", distDir]);

  const extractedTypes = path.join(distDir, "electron.d.ts");
  if (existsSync(extractedTypes)) {
    renameSync(extractedTypes, path.join(electronDir, "electron.d.ts"));
  }
  writeFileSync(path.join(electronDir, "path.txt"), platformPath);
}

try {
  try {
    const electronBinary = verifyInstalledBinary();
    console.log(`Electron binary verified at ${electronBinary}`);
  } catch (verificationError) {
    console.log(
      `Electron binary verification failed: ${verificationError.message}`
    );
    repairElectronBinary();
    const electronBinary = verifyInstalledBinary();
    console.log(`Electron binary repaired and verified at ${electronBinary}`);
  }
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
